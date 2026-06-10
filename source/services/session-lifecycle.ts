import type { AgentInputItem } from '@openai/agents';
import { SessionInputPlanner } from './session-input-planner.js';
import { ApprovalState } from './approval-state.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { ConversationStore } from './conversation-store.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import type { ILoggingService } from './service-interfaces.js';
import { getMethod } from './interruption-info.js';
import { reconcileHistoryWithToolLedger } from './tool-execution-ledger.js';
import type { SavedToolExecution } from './tool-execution-ledger.js';
import { type TurnState } from './turn-coordinator.js';
import type { ProviderContinuity } from './provider-continuity.js';
import { GenerationGuard } from './generation-guard.js';

/**
 * Owns and manages session-level state transitions:
 * - previousResponseId and pendingModeNotice
 * - generation resets, store clearing
 * - import/export reconciliation
 * - undo side effects
 * - approval/cache/input guard reset hooks
 *
 * ConversationSession delegates to this object for lifecycle operations
 * instead of implementing them inline.
 */
export class SessionLifecycle {
  /** The last response ID from the provider, used for conversation chaining. Delegates to ProviderContinuity. */
  get previousResponseId(): string | null {
    return this.#providerContinuity.previousResponseId;
  }

  set previousResponseId(id: string | null) {
    this.#providerContinuity.update(id);
  }

  /** A pending mode-notice text to prepend to the next user turn. */
  pendingModeNotice: string | null = null;

  #inputPlanner: SessionInputPlanner;
  #approvalState: ApprovalState;
  #toolTracker: SessionToolTracker;
  #shellAutoApproval: ShellAutoApprovalResolver;
  #turnAccumulator: TurnItemAccumulator;
  #conversationStore: ConversationStore;
  #agentClient: ConversationAgentClient;
  #logger: ILoggingService;
  #sessionId: string;
  #appState: TurnState;
  #providerContinuity: ProviderContinuity;
  #generationGuard: GenerationGuard;

  constructor(deps: {
    inputPlanner: SessionInputPlanner;
    approvalState: ApprovalState;
    toolTracker: SessionToolTracker;
    shellAutoApproval: ShellAutoApprovalResolver;
    turnAccumulator: TurnItemAccumulator;
    conversationStore: ConversationStore;
    agentClient: ConversationAgentClient;
    logger: ILoggingService;
    sessionId: string;
    appState: TurnState;
    providerContinuity: ProviderContinuity;
    generationGuard: GenerationGuard;
  }) {
    this.#inputPlanner = deps.inputPlanner;
    this.#approvalState = deps.approvalState;
    this.#toolTracker = deps.toolTracker;
    this.#shellAutoApproval = deps.shellAutoApproval;
    this.#turnAccumulator = deps.turnAccumulator;
    this.#conversationStore = deps.conversationStore;
    this.#agentClient = deps.agentClient;
    this.#logger = deps.logger;
    this.#sessionId = deps.sessionId;
    this.#appState = deps.appState;
    this.#providerContinuity = deps.providerContinuity;
    this.#generationGuard = deps.generationGuard;
  }

  // ── Public lifecycle methods ─────────────────────────────────────

  /**
   * Full session reset: clears conversation store, tool tracker, input planner,
   * and all continuity state.
   */
  resetSession(options?: { clearConversations?: boolean }): void {
    this.#generationGuard.invalidate();
    this.#resetProviderContinuity(options);
    this.#conversationStore.clear();
    this.#toolTracker.reset();
    this.#inputPlanner.reset();
    this.#appState.statusMachine.abort();
  }

  /**
   * Reset after a provider/model/reasoning-effort/temperature change.
   * Keeps the conversation store intact but severs the response chain.
   */
  afterProviderChanged(): void {
    this.#generationGuard.invalidate();
    this.#resetProviderContinuity();
    this.#appState.statusMachine.abort();
  }

  /**
   * Clean up after an undo operation.
   *
   * Call this *after* the user turn has been removed from the conversation store.
   */
  afterUndo(): void {
    this.#generationGuard.invalidate();
    this.#pruneToolLedgerToCurrentHistory();
    this.#resetProviderContinuity();
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
      previousResponseId: this.previousResponseId,
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
    this.#conversationStore.clear();
    this.#toolTracker.import(state.toolLedger);
    const reconciled = reconcileHistoryWithToolLedger(state.history, state.toolLedger);
    if (reconciled.addedCompletedPairs > 0 || reconciled.droppedIncompleteCalls > 0) {
      this.#logger.warn('Reconciled saved conversation history with tool execution ledger', {
        eventType: 'conversation.tool_ledger.reconciled',
        category: 'conversation',
        phase: 'resume',
        sessionId: this.#sessionId,
        addedCompletedPairs: reconciled.addedCompletedPairs,
        droppedIncompleteCalls: reconciled.droppedIncompleteCalls,
      });
    }
    for (const item of reconciled.history as AgentInputItem[]) {
      this.#conversationStore.addImportedItem(item);
    }
    // Provider-side response chains can expire while the local transcript remains valid.
    // Force the first resumed turn to resync from full history; successful completion
    // will populate a fresh previousResponseId for subsequent chained turns.
    this.previousResponseId = null;
    this.#toolTracker.clearEmittedToolStarted();
    this.#inputPlanner.reset();
    this.#shellAutoApproval.clearCache();
    this.#approvalState.clearPending();
    this.#approvalState.consumeAborted();
    this.#toolTracker.clearArguments();
    this.#turnAccumulator.resetPersistedTurnState();
    this.#inputPlanner.markResumedSession({
      updatedAtMs: state.updatedAt ? Date.parse(state.updatedAt) : null,
    });
    this.#generationGuard.invalidate();
    this.#appState.statusMachine.abort();
  }

  // ── Internal helpers ──────────────────────────────────────────────

  #resetProviderContinuity({ clearConversations = true }: { clearConversations?: boolean } = {}): void {
    this.#providerContinuity.clear();
    this.#approvalState.clearPending();
    this.#approvalState.consumeAborted();
    this.#toolTracker.clearArguments();
    this.#toolTracker.clearEmittedToolStarted();
    this.#shellAutoApproval.clearCache();
    this.#inputPlanner.reset();
    this.#turnAccumulator.resetPersistedTurnState();

    if (clearConversations) {
      const clearConversationsFn = getMethod<[], void>(this.#agentClient, 'clearConversations');
      clearConversationsFn?.call(this.#agentClient);
    }
  }

  #pruneToolLedgerToCurrentHistory(): void {
    this.#toolTracker.pruneToCurrentHistory();
  }
}
