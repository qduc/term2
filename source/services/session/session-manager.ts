import type { UserTurn } from '../../types/user-turn.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ISettingsService } from '../service-interfaces.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { ConversationLogger } from '../logging/conversation-logger.js';
import type { StateSnapshot } from '../logging/conversation-log-events.js';
import { SessionLifecycle } from './session-lifecycle.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { SessionInputPlanner } from './session-input-planner.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import { getMethod } from '../interruption-info.js';
import { projectSnapshot } from '../conversation/conversation-state-projector.js';

/**
 * Facade that owns state/persistence/undo/shell-context/mode-notice operations
 * for the conversation session. Extracted from ConversationSession to reduce
 * its surface area and make the delegation boundary explicit.
 */
export class SessionManager {
  readonly #conversationStore: ConversationStore;
  readonly #toolTracker: SessionToolTracker;
  readonly #state: SessionLifecycle;
  readonly #conversationLogger: ConversationLogger;
  readonly #agentClient: ConversationAgentClient;
  readonly #settingsService?: ISettingsService;
  readonly #inputPlanner: SessionInputPlanner;

  constructor(deps: {
    conversationStore: ConversationStore;
    toolTracker: SessionToolTracker;
    state: SessionLifecycle;
    conversationLogger: ConversationLogger;
    agentClient: ConversationAgentClient;
    settingsService?: ISettingsService;
    inputPlanner: SessionInputPlanner;
  }) {
    this.#conversationStore = deps.conversationStore;
    this.#toolTracker = deps.toolTracker;
    this.#state = deps.state;
    this.#conversationLogger = deps.conversationLogger;
    this.#agentClient = deps.agentClient;
    this.#settingsService = deps.settingsService;
    this.#inputPlanner = deps.inputPlanner;
  }

  // ── Reset ─────────────────────────────────────────────────────────

  reset(): void {
    this.#state.resetSession();
  }

  // ── Undo ──────────────────────────────────────────────────────────

  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null {
    const removed = this.#conversationStore.removeLastUserTurn();
    if (removed === null) return null;
    this.#afterUndo(1);
    return removed;
  }

  peekLastToolOutput(): {
    index: number;
    callId?: string;
    toolName?: string;
    output?: unknown;
    itemType: string;
  } | null {
    // Reconcile with the tool ledger before reading. When a stream ends
    // unexpectedly (interrupted/aborted), finalize() returns 'partial' and
    // does not commit tool outputs to the store. The ledger, however,
    // captured them during streaming. Reconciling flushes those pending
    // entries into the store so peekLastToolOutput can find them.
    this.#toolTracker.reconcileAndUpdateHistory();
    return this.#conversationStore.peekLastToolOutput();
  }

  retryLastToolOutput(): {
    index: number;
    callId?: string;
    toolName?: string;
    output?: unknown;
    itemType: string;
  } | null {
    // Same reconciliation as peekLastToolOutput — see comment above.
    this.#toolTracker.reconcileAndUpdateHistory();
    const removed = this.#conversationStore.removeAfterLastToolOutput();
    if (removed === null) return null;
    this.#afterToolRetry();
    return removed;
  }

  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null {
    const removed = this.#conversationStore.removeNLastUserTurns(n);
    if (removed === null) return null;
    this.#afterUndo(n);
    return removed;
  }

  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.#conversationStore.listUserTurns();
  }

  // ── Snapshot / State ──────────────────────────────────────────────

  getCurrentSnapshot(): StateSnapshot {
    const providerFn = getMethod<[], string>(this.#agentClient, 'getProvider');
    const provider = providerFn
      ? providerFn.call(this.#agentClient)
      : this.#settingsService?.get<string>('agent.provider');
    const model = this.#settingsService?.get<string>('agent.model');
    return projectSnapshot({
      history: this.#conversationStore.getHistory(),
      previousResponseId: this.#state.exportPersistedState().previousResponseId,
      toolLedger: this.#toolTracker.export(),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }

  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return this.#state.exportPersistedState();
  }

  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.#state.importPersistedState(state);
  }

  // ── Shell context / mode notice ───────────────────────────────────

  addShellContext(historyText: string): void {
    this.#conversationStore.addShellContext(historyText);
  }

  queueModeNotice(text: string): void {
    this.#state.pendingModeNotice = text;
  }

  previewLargeUncachedInput(input: string | UserTurn, now = Date.now()) {
    return this.#inputPlanner.previewLargeUncachedInput(input, now, {
      pendingModeNotice: this.#state.pendingModeNotice,
    });
  }

  previewInputSurge(input: string | UserTurn) {
    return this.#inputPlanner.previewInputSurge(input, {
      pendingModeNotice: this.#state.pendingModeNotice,
    });
  }

  // ── Private helpers ───────────────────────────────────────────────

  #afterUndo(count: number): void {
    this.#state.afterUndo();
    this.#conversationLogger.log({ type: 'undo', removedUserTurns: count, snapshot: this.getCurrentSnapshot() });
  }

  #afterToolRetry(): void {
    this.#state.afterToolRetry();
  }
}
