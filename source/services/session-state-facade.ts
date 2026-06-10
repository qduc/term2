import type { AgentInputItem } from '@openai/agents';
import type { UserTurn } from '../types/user-turn.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import type { ISettingsService } from './service-interfaces.js';
import { ConversationStore } from './conversation-store.js';
import { ConversationLogger } from './conversation-logger.js';
import type { StateSnapshot } from './conversation-log-events.js';
import { SessionStateController } from './session-state-controller.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { reconcileHistoryWithToolLedger, type SavedToolExecution } from './tool-execution-ledger.js';
import { getMethod } from './interruption-info.js';

/**
 * Facade that owns state/persistence/undo/shell-context/mode-notice operations
 * for the conversation session. Extracted from ConversationSession to reduce
 * its surface area and make the delegation boundary explicit.
 */
export class SessionStateFacade {
  readonly #conversationStore: ConversationStore;
  readonly #toolTracker: SessionToolTracker;
  readonly #state: SessionStateController;
  readonly #conversationLogger: ConversationLogger;
  readonly #agentClient: ConversationAgentClient;
  readonly #settingsService?: ISettingsService;
  readonly #inputPlanner: SessionInputPlanner;

  constructor(deps: {
    conversationStore: ConversationStore;
    toolTracker: SessionToolTracker;
    state: SessionStateController;
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
    return {
      history: reconcileHistoryWithToolLedger(this.#conversationStore.getHistory(), this.#toolTracker.export())
        .history as AgentInputItem[],
      previousResponseId: this.#state.previousResponseId,
      toolLedger: this.#toolTracker.export(),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    };
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

  // ── Private helpers ───────────────────────────────────────────────

  #afterUndo(count: number): void {
    this.#state.afterUndo();
    this.#conversationLogger.log({ type: 'undo', removedUserTurns: count, snapshot: this.getCurrentSnapshot() });
  }
}
