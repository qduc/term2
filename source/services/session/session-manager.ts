import type { UserTurn } from '../../types/user-turn.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ISettingsService } from '../service-interfaces.js';
import type { RewindTarget, RewindTargetId } from '../conversation/conversation-store.js';
import { ConversationRecord } from '../conversation/conversation-record.js';
import { ConversationLogger } from '../logging/conversation-logger.js';
import type { StateSnapshot } from '../logging/conversation-log-events.js';
import { SessionLifecycle } from './session-lifecycle.js';
import { SessionInputPlanner } from './session-input-planner.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import { getMethod } from '../interruption-info.js';

/**
 * Facade that owns state/persistence/undo/shell-context/mode-notice operations
 * for the conversation session. Extracted from ConversationSession to reduce
 * its surface area and make the delegation boundary explicit.
 */
export class SessionManager {
  readonly #record: ConversationRecord;
  readonly #state: SessionLifecycle;
  readonly #conversationLogger: ConversationLogger;
  readonly #agentClient: ConversationAgentClient;
  readonly #settingsService?: ISettingsService;
  readonly #inputPlanner: SessionInputPlanner;

  constructor(deps: {
    record: ConversationRecord;
    state: SessionLifecycle;
    conversationLogger: ConversationLogger;
    agentClient: ConversationAgentClient;
    settingsService?: ISettingsService;
    inputPlanner: SessionInputPlanner;
  }) {
    this.#record = deps.record;
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
    const removed = this.#record.removeLastUserTurn();
    if (removed === null) return null;
    this.#afterUndo(1);
    return removed;
  }

  /** Discard the latest attempt, retaining the exact original provider input. */
  retryLastUserTurn(): boolean {
    const retry = this.#record.retryLastUserTurn();
    if (!retry) return false;
    this.#state.afterUndo();
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
    this.#afterToolRetry();
    return removed;
  }

  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null {
    const removed = this.#record.removeNLastUserTurns(n);
    if (removed === null) return null;
    this.#afterUndo(n);
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
    this.#afterUndo(removed.discardedTurns);
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
      previousResponseId: this.#state.exportPersistedState().previousResponseId,
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
    this.#record.addShellContext(historyText);
  }

  queueModeNotice(text: string): void {
    // Compose instead of overwrite: a profile transition and tool-toggle
    // warnings (or several toggles in one batch) must all reach the next turn.
    const existing = this.#state.pendingModeNotice;
    this.#state.pendingModeNotice = existing ? `${existing}\n\n${text}` : text;
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
