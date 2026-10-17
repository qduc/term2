import { getMethod } from '../interruption-info.js';
import type { StateSnapshot } from '../logging/conversation-log-events.js';
import { ConversationLogger } from '../logging/conversation-logger.js';
import type { RewindTarget, RewindTargetId } from '../conversation/conversation-store.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { UserTurn } from '../../types/user-turn.js';
import { ConversationRecord } from '../conversation/conversation-record.js';
import { SessionInputPlanner } from './session-input-planner.js';
import type { ISettingsService } from '../service-interfaces.js';
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
 * - complete undo/retry/rewind operations and their logging
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
  readonly #conversationLogger: ConversationLogger;
  readonly #agentClient: ConversationAgentClient;
  readonly #settingsService?: ISettingsService;

  constructor(deps: {
    inputPlanner: SessionInputPlanner;
    conversationLogger: ConversationLogger;
    agentClient: ConversationAgentClient;
    settingsService?: ISettingsService;
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
    this.#conversationLogger = deps.conversationLogger;
    this.#agentClient = deps.agentClient;
    this.#settingsService = deps.settingsService;
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
   * Private step of an accepted synchronous history operation. No caller must
   * remember a separate cleanup or logging call.
   */
  #afterUndo(): void {
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
    this.#terminateActiveTurn?.();
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

  // ── Reset ─────────────────────────────────────────────────────────

  reset(): void {
    this.resetSession();
  }

  // ── Undo ──────────────────────────────────────────────────────────

  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null {
    const removed = this.#record.removeLastUserTurn();
    if (removed === null) return null;
    this.#completeUndo(1);
    return removed;
  }

  /** Discard the latest attempt, retaining the exact original provider input. */
  retryLastUserTurn(): boolean {
    const retry = this.#record.retryLastUserTurn();
    if (!retry) return false;
    this.#afterUndo();
    this.#conversationLogger.log({
      type: 'undo',
      removedUserTurns: 1,
      snapshot: { ...this.getCurrentSnapshot(), ...retry.discardedSnapshot },
    });
    return true;
  }

  peekLastToolOutput(): {
    index: number;
    callId?: string;
    toolName?: string;
    output?: unknown;
    itemType: string;
  } | null {
    return this.#record.peekLastToolOutput();
  }

  retryLastToolOutput(): {
    index: number;
    callId?: string;
    toolName?: string;
    output?: unknown;
    itemType: string;
  } | null {
    const removed = this.#record.removeAfterLastToolOutput();
    if (removed === null) return null;
    this.#afterUndo();
    return removed;
  }

  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null {
    const removed = this.#record.removeNLastUserTurns(n);
    if (removed === null) return null;
    this.#completeUndo(n);
    return removed;
  }

  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.#record.listUserTurns();
  }

  listRewindTargets(): RewindTarget[] {
    return this.#record.listRewindTargets();
  }

  /**
   * Rewind through a snapshot-scoped domain target. This is the only target
   * based rewind entry point: lifecycle cleanup and undo logging happen once,
   * and only after the store accepted the target.
   */
  rewindToTarget(targetId: RewindTargetId): { text: string; images?: UserTurn['images'] } | null {
    const removed = this.#record.rewindToTarget(targetId);
    if (removed === null) return null;
    this.#completeUndo(removed.discardedTurns);
    return { text: removed.text, ...(removed.images ? { images: removed.images } : {}) };
  }

  // ── Snapshot / State ──────────────────────────────────────────────

  getCurrentSnapshot(): StateSnapshot {
    const providerFn = getMethod<[], string>(this.#agentClient, 'getProvider');
    const provider = providerFn
      ? providerFn.call(this.#agentClient)
      : this.#settingsService?.get('agent.modelSelection').provider;
    const model = this.#settingsService?.get('agent.modelSelection').model;
    return this.#record.snapshot({
      previousResponseId: this.#providerContinuity.previousResponseId,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }

  getProviderHistorySnapshot() {
    return this.#record.getProviderHistorySnapshot();
  }

  replaceHistoryAtRevision(expectedRevision: number, history: readonly ProviderInputItem[]): boolean {
    return this.#record.replaceHistoryAtRevision(expectedRevision, history);
  }

  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return this.exportPersistedState();
  }

  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.importPersistedState(state);
  }

  // ── Shell context / mode notice ───────────────────────────────────

  addShellContext(historyText: string): void {
    this.#record.addShellContext(historyText);
  }

  queueModeNotice(text: string): void {
    // Compose instead of overwrite: a profile transition and tool-toggle
    // warnings (or several toggles in one batch) must all reach the next turn.
    const existing = this.pendingModeNotice;
    this.pendingModeNotice = existing ? `${existing}\n\n${text}` : text;
  }

  previewLargeUncachedInput(input: string | UserTurn, now = Date.now()) {
    return this.#inputPlanner.previewLargeUncachedInput(input, now, {
      pendingModeNotice: this.pendingModeNotice,
    });
  }

  previewInputSurge(input: string | UserTurn) {
    return this.#inputPlanner.previewInputSurge(input, {
      pendingModeNotice: this.pendingModeNotice,
    });
  }

  /** No await separates accepted history changes, retirement, reset and undo logging. */
  #completeUndo(count: number): void {
    this.#afterUndo();
    this.#conversationLogger.log({ type: 'undo', removedUserTurns: count, snapshot: this.getCurrentSnapshot() });
  }

  #clearAccessState(): void {
    if (this.#sessionAccess) {
      this.#sessionAccess.clearTransient();
      return;
    }
  }
}

/** Complete public state operations; cleanup primitives remain an internal concern. */
export type SessionState = Pick<
  SessionLifecycle,
  | 'reset'
  | 'undoLastUserTurn'
  | 'retryLastUserTurn'
  | 'peekLastToolOutput'
  | 'retryLastToolOutput'
  | 'undoNUserTurns'
  | 'listUserTurns'
  | 'listRewindTargets'
  | 'rewindToTarget'
  | 'getCurrentSnapshot'
  | 'getProviderHistorySnapshot'
  | 'replaceHistoryAtRevision'
  | 'exportState'
  | 'importState'
  | 'addShellContext'
  | 'queueModeNotice'
  | 'previewLargeUncachedInput'
  | 'previewInputSurge'
>;
