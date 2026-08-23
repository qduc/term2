import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import { GenerationGuard } from '../generation-guard.js';
import { SessionContinuityReset } from './session-continuity-reset.js';
import { projectImportedState, ProjectionWarningCode } from '../conversation/conversation-state-projector.js';
import { ImportedConversationStateSchema } from '../conversation/conversation-state-schema.js';
import type { SessionAccessState } from './session-access-state.js';
import type { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';

/**
 * Owns and manages session-level state transitions:
 * - pendingModeNotice
 * - generation resets, store clearing
 * - import/export reconciliation
 * - undo side effects
 * - approval/cache/input guard reset hooks
 *
 * ConversationSession delegates to this object for lifecycle operations
 * instead of implementing them inline.
 */
export class SessionLifecycle {
  /** A pending mode-notice text to prepend to the next user turn. */
  pendingModeNotice: string | null = null;

  #inputPlanner: SessionInputPlanner;
  #toolTracker: SessionToolTracker;
  #conversationStore: ConversationStore;
  #logger: ILoggingService;
  #sessionId: string;
  #appState: { statusMachine: TurnStatusMachine };
  #providerContinuity: ProviderContinuity;
  #generationGuard: GenerationGuard;
  #continuityReset: SessionContinuityReset;
  #sessionAccess: SessionAccessState | undefined;
  #terminateActiveTurn: (() => void) | undefined;
  #journal: AssistantTurnJournal;

  constructor(deps: {
    inputPlanner: SessionInputPlanner;
    toolTracker: SessionToolTracker;
    conversationStore: ConversationStore;
    logger: ILoggingService;
    sessionId: string;
    appState: { statusMachine: TurnStatusMachine };
    providerContinuity: ProviderContinuity;
    generationGuard: GenerationGuard;
    continuityReset: SessionContinuityReset;
    /**
     * Streams assistant items into the durable journal. Undo/reset must prune
     * it alongside the store and ledger: failure recovery rebuilds the tool
     * ledger from this buffer, so skipped pruning would resurrect tool pairs
     * from undone turns into the next provider request.
     */
    journal: AssistantTurnJournal;
    /** Handle-owned root capability; absent only for compatibility callers. */
    sessionAccess?: SessionAccessState;
    /** Notify the coordinator before a generation reset invalidates a turn. */
    terminateActiveTurn?: () => void;
  }) {
    this.#inputPlanner = deps.inputPlanner;
    this.#toolTracker = deps.toolTracker;
    this.#conversationStore = deps.conversationStore;
    this.#logger = deps.logger;
    this.#sessionId = deps.sessionId;
    this.#appState = deps.appState;
    this.#providerContinuity = deps.providerContinuity;
    this.#generationGuard = deps.generationGuard;
    this.#continuityReset = deps.continuityReset;
    this.#sessionAccess = deps.sessionAccess;
    this.#terminateActiveTurn = deps.terminateActiveTurn;
    this.#journal = deps.journal;
  }

  // ── Public lifecycle methods ─────────────────────────────────────

  /**
   * Full session reset: clears conversation store, tool tracker, input planner,
   * and all continuity state.
   */
  resetSession(options?: { clearConversations?: boolean }): void {
    this.#terminateActiveTurn?.();
    this.#generationGuard.invalidate();
    this.#clearAccessState();
    this.#continuityReset.reset(options);
    this.#conversationStore.clear();
    this.#toolTracker.reset();
    this.#inputPlanner.reset();
    this.#journal.clear();
    this.#appState.statusMachine.abort();
  }

  /**
   * Reset after a provider/model/reasoning-effort/temperature change.
   * Keeps the conversation store intact but severs the response chain.
   */
  afterProviderChanged(): void {
    this.#terminateActiveTurn?.();
    this.#generationGuard.invalidate();
    this.#continuityReset.reset();
    this.#appState.statusMachine.abort();
  }

  /**
   * Clean up after an undo operation.
   *
   * Call this *after* the user turn has been removed from the conversation store.
   */
  afterUndo(): void {
    this.#terminateActiveTurn?.();
    this.#generationGuard.invalidate();
    this.#pruneToolLedgerToCurrentHistory();
    this.#journal.pruneToUserTurnCount(this.#conversationStore.listUserTurns().length);
    this.#continuityReset.reset();
    this.#inputPlanner.markUndoOrRewind();
    this.#appState.statusMachine.abort();
  }

  /**
   * Reset state after rewinding to the last tool output.
   */
  afterToolRetry(): void {
    this.#terminateActiveTurn?.();
    this.#generationGuard.invalidate();
    this.#pruneToolLedgerToCurrentHistory();
    this.#continuityReset.reset();
    this.#inputPlanner.markUndoOrRewind();
    this.#appState.statusMachine.abort();
  }

  /**
   * Export the current session state for persistence.
   */
  exportPersistedState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return {
      history: this.#toolTracker.getReconciledHistory(),
      previousResponseId: this.#providerContinuity.previousResponseId,
      toolLedger: this.#toolTracker.export(),
    };
  }

  /**
   * Import a previously persisted session state.
   *
   * Reconciles the persisted history with the tool execution ledger,
   * clears the current store, and resets all continuity state so the
   * first resumed turn sends full history.
   */
  importPersistedState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    const validatedState = ImportedConversationStateSchema.parse(state);
    this.#clearAccessState();
    this.#conversationStore.clear();
    this.#toolTracker.import(validatedState.toolLedger);
    const projected = projectImportedState({
      history: validatedState.history,
      previousResponseId: validatedState.previousResponseId,
      toolLedger: validatedState.toolLedger,
    });
    if (projected.warnings.length > 0) {
      const addedCompletedPairs =
        (
          projected.warnings.find((warning) => warning.code === ProjectionWarningCode.CompletedToolHistoryInserted)
            ?.detail as { addedCompletedPairs?: number } | undefined
        )?.addedCompletedPairs ?? 0;
      const droppedIncompleteCalls =
        (
          projected.warnings.find((warning) => warning.code === ProjectionWarningCode.IncompleteToolHistoryDropped)
            ?.detail as { droppedIncompleteCalls?: number } | undefined
        )?.droppedIncompleteCalls ?? 0;
      this.#logger.warn('Reconciled saved conversation history with tool execution ledger', {
        eventType: 'conversation.tool_ledger.reconciled',
        category: 'conversation',
        phase: 'resume',
        sessionId: this.#sessionId,
        addedCompletedPairs,
        droppedIncompleteCalls,
      });
    }
    for (const item of projected.history as ProviderInputItem[]) {
      this.#conversationStore.addImportedItem(item);
    }
    // Provider-side response chains can expire while the local transcript remains valid.
    // Force the first resumed turn to resync from full history; successful completion
    // will populate a fresh previousResponseId for subsequent chained turns.
    this.#continuityReset.reset({ clearConversations: false });
    this.#inputPlanner.markResumedSession({
      updatedAtMs: validatedState.updatedAt ? Date.parse(validatedState.updatedAt) : null,
    });
    this.#generationGuard.invalidate();
    this.#appState.statusMachine.abort();
  }

  #pruneToolLedgerToCurrentHistory(): void {
    this.#toolTracker.pruneToCurrentHistory();
  }

  #clearAccessState(): void {
    if (this.#sessionAccess) {
      this.#sessionAccess.clearTransient();
      return;
    }
  }
}
