import { ConversationRecord } from '../conversation/conversation-record.js';
import { SessionInputPlanner } from './session-input-planner.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import { GenerationGuard } from '../generation-guard.js';
import { SessionContinuityReset } from './session-continuity-reset.js';
import { ProjectionWarningCode } from '../conversation/conversation-state-projector.js';
import type { SessionAccessState } from './session-access-state.js';
import type { PendingInteractionState } from './pending-interaction-state.js';
import type { SessionIdSource } from './session-identity.js';
import { resolveSessionId } from './session-identity.js';

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
  #record: ConversationRecord;
  #logger: ILoggingService;
  #sessionId: SessionIdSource;
  #appState: { statusMachine: TurnStatusMachine };
  #providerContinuity: ProviderContinuity;
  #generationGuard: GenerationGuard;
  #continuityReset: SessionContinuityReset;
  #sessionAccess: SessionAccessState | undefined;
  #terminateActiveTurn: (() => void) | undefined;
  #pendingInteraction: PendingInteractionState | undefined;

  constructor(deps: {
    inputPlanner: SessionInputPlanner;
    record: ConversationRecord;
    logger: ILoggingService;
    sessionId: SessionIdSource;
    appState: { statusMachine: TurnStatusMachine };
    providerContinuity: ProviderContinuity;
    generationGuard: GenerationGuard;
    continuityReset: SessionContinuityReset;
    /** Handle-owned root capability; absent only for compatibility callers. */
    sessionAccess?: SessionAccessState;
    /** Notify the coordinator before a generation reset invalidates a turn. */
    terminateActiveTurn?: () => void;
    pendingInteraction?: PendingInteractionState;
  }) {
    this.#inputPlanner = deps.inputPlanner;
    this.#record = deps.record;
    this.#logger = deps.logger;
    this.#sessionId = deps.sessionId;
    this.#appState = deps.appState;
    this.#providerContinuity = deps.providerContinuity;
    this.#generationGuard = deps.generationGuard;
    this.#continuityReset = deps.continuityReset;
    this.#sessionAccess = deps.sessionAccess;
    this.#terminateActiveTurn = deps.terminateActiveTurn;
    this.#pendingInteraction = deps.pendingInteraction;
  }

  // ── Public lifecycle methods ─────────────────────────────────────

  /**
   * Full session reset: clears conversation store, tool tracker, input planner,
   * and all continuity state.
   */
  resetSession(options?: { clearConversations?: boolean; rollover?: boolean }): void {
    this.#terminateActiveTurn?.();
    this.#generationGuard.invalidate();
    this.#clearAccessState();
    this.#continuityReset.reset(options);
    this.#record.reset();
    this.#inputPlanner.reset();
    this.#pendingInteraction?.clear();
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
    return this.#record.exportState(this.#providerContinuity.previousResponseId);
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
    const { validated: validatedState, projected } = this.#record.importState(state);
    this.#clearAccessState();
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
        sessionId: resolveSessionId(this.#sessionId),
        addedCompletedPairs,
        droppedIncompleteCalls,
      });
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

  #clearAccessState(): void {
    if (this.#sessionAccess) {
      this.#sessionAccess.clearTransient();
      return;
    }
  }
}
