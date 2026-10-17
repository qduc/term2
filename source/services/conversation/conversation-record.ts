import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { ILoggingService } from '../service-interfaces.js';
import { ConversationStore, type RewindTargetId } from './conversation-store.js';
import { ToolExecutionLedger, callIdOf, type SavedToolExecution } from '../tool-execution-ledger.js';
import { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import type { AssistantJournalItemLogEvent, LogEvent } from '../logging/conversation-log-events.js';
import { normalizeRunItem } from './run-item-normalizer.js';
import { selectAcceptedStreamHistory, type StreamHistorySource } from './conversation-record-stream.js';
import type { AgentStream } from '../agent-stream.js';
import type { SessionIdSource } from '../session/session-identity.js';
import { projectProviderHistory, projectImportedState, projectSnapshot } from './conversation-state-projector.js';
import { buildToolLedgerFromJournalEvents } from './journal-to-ledger.js';
import { ImportedConversationStateSchema } from './conversation-state-schema.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { OpenAIRootCheckpointLifecycleObserver } from '../openai-root-checkpoint-lifecycle-observer.js';
import type { RecoveryPlan, RecoveryState, CommittedToolContinuation } from '../retry/retry-contracts.js';

export type RecordAcceptanceReceipt = {
  accepted: 'memory';
  /** A void sink returning is acknowledgement of delivery, never proof of fsync. */
  persistence: 'not_requested' | 'unconfigured' | 'acknowledged' | 'failed';
};

/**
 * Sole acceptance authority for provider history, tool evidence and assistant journal.
 * Physical execution and recovery policy remain with their existing owners. All
 * reconstruction, rewind and import transitions keep these representations together.
 */
export class ConversationRecord {
  readonly #store = new ConversationStore();
  #ledger = new ToolExecutionLedger();
  readonly #journal: AssistantTurnJournal;
  readonly #logger?: ILoggingService;
  #journalSink: ((event: LogEvent) => void) | null = null;
  #segmentBaseline: ReturnType<ConversationStore['getProviderHistorySnapshot']> | undefined;
  #lastPersistence: RecordAcceptanceReceipt['persistence'] = 'unconfigured';
  #pendingReasoningText = '';
  #segmentSource: StreamHistorySource = 'startStream';
  #recoveryBaselines: Record<'initial' | 'decision', AssistantJournalItemLogEvent[]> = { initial: [], decision: [] };
  readonly #providerContext?: ProviderContinuity;
  readonly #checkpointObserver?: OpenAIRootCheckpointLifecycleObserver;

  constructor(
    options: {
      logger?: ILoggingService;
      providerContext?: ProviderContinuity;
      checkpointObserver?: OpenAIRootCheckpointLifecycleObserver;
    } = {},
  ) {
    this.#logger = options.logger;
    this.#providerContext = options.providerContext;
    this.#checkpointObserver = options.checkpointObserver;
    this.#attachUserTurnCount();
    this.#journal = new AssistantTurnJournal({ getCurrentTurnId: () => this.getCurrentTurnId() });
  }

  #attachUserTurnCount(): void {
    this.#ledger.setUserTurnCountSource(() => this.#store.listUserTurns().length);
  }

  setJournalSink(sink: ((event: LogEvent) => void) | null): void {
    if (this.#journalSink === sink) return;
    this.#journalSink = sink;
    this.#journal.setSink(sink ? (event) => this.#deliverJournalEvent(event) : null);
    if (!sink) this.#lastPersistence = 'unconfigured';
  }

  /** Preserve the pre-attempt recovery baseline without exporting journal state. */
  beginAttempt(): void {
    this.#recoveryBaselines.initial = this.#snapshotJournal();
    this.#segmentSource = 'startStream';
  }

  /** A decision changes the segment view, never the execution position. */
  beginDecisionResolution(source: 'continueRunStream' | 'abortResolution' = 'continueRunStream'): void {
    this.#recoveryBaselines.decision = this.#snapshotJournal();
    this.#segmentSource = source;
  }

  beginTurn(): void {
    this.#pendingReasoningText = '';
    this.#ledger.beginTurn();
    this.#journal.resetForNewTurn();
  }
  getCurrentTurnId(): string {
    return this.#ledger.getCurrentTurnId();
  }
  getHistory(): ProviderInputItem[] {
    return this.#store.getHistory();
  }
  getProviderHistorySnapshot() {
    return this.#store.getProviderHistorySnapshot();
  }
  getProviderHistoryIdentity() {
    return this.#store.getProviderHistoryIdentity();
  }
  getLastUserMessage(): string {
    return this.#store.getLastUserMessage();
  }
  listUserTurns() {
    return this.#store.listUserTurns();
  }
  listRewindTargets() {
    return this.#store.listRewindTargets();
  }
  #snapshotJournal(): AssistantJournalItemLogEvent[] {
    return structuredClone(this.#journal.getEvents());
  }
  getCurrentTurnItems() {
    return structuredClone(this.#journal.getCurrentTurnItems());
  }
  recordTextDelta(delta: string): void {
    this.#journal.recordTextDelta(delta);
  }
  recordReasoningDelta(delta: string): void {
    this.#pendingReasoningText += delta;
    this.#journal.recordReasoningDelta(delta);
  }
  rollbackReasoning(characters: number): void {
    this.#pendingReasoningText = this.#pendingReasoningText.slice(
      0,
      Math.max(0, this.#pendingReasoningText.length - characters),
    );
  }
  exportToolEvidence(): SavedToolExecution[] {
    return structuredClone(this.#ledger.export());
  }
  activeCallIdsForCurrentTurn(): string[] {
    return this.#ledger.activeCallIdsForTurn();
  }
  completedResultCallIdsForCurrentTurn(): string[] {
    return this.#ledger.completedResultCallIdsForCurrentTurn();
  }
  unsettledToolCallIdsForCurrentTurn(): string[] {
    const completed = new Set(this.completedResultCallIdsForCurrentTurn());
    return this.activeCallIdsForCurrentTurn().filter((id) => !completed.has(id));
  }
  inspectCommittedToolContinuation(): CommittedToolContinuation {
    const live = this.#ledger.export().filter((entry) => entry.turnId === this.getCurrentTurnId());
    const completed = live.filter((entry) => entry.status === 'completed');
    const historyIds = new Set(this.getReconciledHistory().map(callIdOf).filter(Boolean));
    return {
      completedToolCount: completed.length,
      allToolsCompleted: live.length > 0 && live.every((entry) => entry.status === 'completed'),
      completedPairsPresentInHistory: completed.every((entry) => historyIds.has(entry.callId)),
    };
  }

  acceptInput(turn: string | UserTurn): RecordAcceptanceReceipt {
    this.#store.addUserTurn(turn);
    return { accepted: 'memory', persistence: 'not_requested' };
  }
  addUserTurn(turn: string | UserTurn): RecordAcceptanceReceipt {
    return this.acceptInput(turn);
  }
  removeLastUserMessage(): void {
    this.#store.removeLastUserMessage();
  }
  addShellContext(text: string): void {
    this.#store.addShellContext(text);
  }
  markDispatched(callId: string): void {
    this.#ledger.markDispatched(callId);
  }
  recordFunctionCall(item: unknown): void {
    this.#ledger.recordFunctionCall(item);
  }
  recordFunctionResult(item: unknown): void {
    this.#ledger.recordFunctionResult(item);
  }
  recordAbortedApproval(output: string, error: string, callId?: string): void {
    this.#ledger.recordAbortedApproval(output, error, callId);
  }
  markOpenCallsAborted(error: string, callId?: string): void {
    this.#ledger.markOpenCallsAborted(error, callId);
  }
  getRecoverySummary() {
    return this.#ledger.getRecoverySummary();
  }

  /** A segment is a wire view over the same record, not another acceptance owner. */
  beginSegment(): void {
    this.#segmentBaseline = this.#store.getProviderHistorySnapshot();
    this.#pendingReasoningText = '';
  }

  /** Accept one observed provider item into both evidence representations before publication. */
  acceptObservedItem(item: unknown): RecordAcceptanceReceipt {
    this.#lastPersistence = this.#journalSink ? 'not_requested' : 'unconfigured';
    // Journal deduplication is independent of execution occurrence: a real new
    // invocation may reuse a provider call id within this logical turn.
    for (const normalized of normalizeRunItem(item)) {
      if (normalized.type === 'tool_call') {
        if (this.#pendingReasoningText) this.#ledger.recordReasoningText(this.#pendingReasoningText);
        this.#pendingReasoningText = '';
        this.#ledger.recordFunctionCall(item);
      } else if (normalized.type === 'tool_result') {
        this.#ledger.recordFunctionResult(item);
        if (this.#segmentSource !== 'startStream' && this.#journalSink) {
          const entry = this.#ledger.export().find((candidate) => candidate.callId === normalized.callId);
          this.#deliverJournalEvent({
            type: 'tool_result',
            callId: normalized.callId,
            toolName: entry?.toolName ?? normalized.toolName,
            status:
              entry?.status === 'failed' || entry?.status === 'aborted' || entry?.status === 'unknown'
                ? entry.status
                : 'completed',
            output: entry?.output ?? normalized.output,
            ...(entry?.historyItems ? { historyItems: entry.historyItems } : {}),
          });
        }
      }
    }
    // The transcript is immediately readable by preparation/recovery. Segment
    // selection later reconciles the provider's terminal representation against
    // the baseline, rather than appending these same observations twice.
    this.#store.appendOutput([item as ProviderInputItem]);
    this.#journal.recordRunItem(item);
    return this.#receipt();
  }

  /** Accept a completed or interrupted execution view, independent of rendering. */
  acceptSegment(
    stream: AgentStream,
    inputMode: 'delta' | 'full_history',
    diagnostics: { logger: ILoggingService; sessionId: SessionIdSource },
  ) {
    const selected = selectAcceptedStreamHistory({
      stream,
      history: this.#segmentBaseline ? [...this.#segmentBaseline.history] : this.#store.getHistory(),
      inputMode,
      source: this.#segmentSource,
      ...diagnostics,
    });
    const before = this.#segmentBaseline?.revision ?? this.#store.getProviderHistoryIdentity().revision;
    if (selected.history) this.#store.replaceHistory(selected.history);
    const snapshot = this.#store.getProviderHistorySnapshot();
    const accepted = {
      kind: selected.terminal ? ('committed' as const) : ('partial' as const),
      snapshot,
      historyCommitted: snapshot.revision !== before,
      lastResponseId: selected.lastResponseId,
      unsettledToolCallIds: this.unsettledToolCallIdsForCurrentTurn(),
    };
    this.#providerContext?.acceptSegment(accepted, this.#checkpointObserver);
    return accepted;
  }

  snapshot(metadata: { previousResponseId: string | null; model?: string; provider?: string }) {
    return projectSnapshot({ ...metadata, history: this.#store.getHistory(), toolLedger: this.#ledger.export() });
  }
  exportState(previousResponseId: string | null) {
    return { history: this.getReconciledHistory(), previousResponseId, toolLedger: this.#ledger.export() };
  }

  getReconciledHistory(): ProviderInputItem[] {
    return projectProviderHistory({ history: this.#store.getHistory(), toolLedger: this.#ledger.export() }).history;
  }
  #reconcileAndUpdateHistory(): boolean {
    const projected = projectProviderHistory({ history: this.#store.getHistory(), toolLedger: this.#ledger.export() });
    if (!projected.warnings.length) return false;
    this.#store.replaceHistory(projected.history);
    return true;
  }

  /** Conditional compaction acceptance preserves the existing transcript revision guard. */
  replaceHistoryAtRevision(revision: number, history: readonly ProviderInputItem[]): boolean {
    return this.#store.replaceHistoryAtRevision(revision, history);
  }

  /** Apply a policy-selected recovery transition without exposing representation precedence. */
  recover(plan: RecoveryPlan, state: RecoveryState): ReturnType<ToolExecutionLedger['getRecoverySummary']> {
    const snapshot = buildToolLedgerFromJournalEvents(
      this.#recoveryBaselines[state.baseline],
      new Date().toISOString(),
    );
    if (plan.kind === 'replay_turn') {
      this.#ledger.import(snapshot);
      if (plan.rollbackUserMessage) this.#store.removeLastUserMessage();
      if (plan.errorContext) this.#store.addErrorContext(plan.errorContext);
    } else if (plan.kind === 'retry_fresh') {
      if (state.stream) this.#ledger.settleOpenCallsOnStreamFailure('Stream failed');
      this.#restoreSettledEntries(snapshot);
      if (state.stream) this.#reconcileAndUpdateHistory();
    } else {
      if (state.addedUserMessage && !state.stream) this.#store.removeLastUserMessage();
      if (state.stream) {
        this.#ledger.settleOpenCallsOnStreamFailure('Stream failed');
        this.#ledger.markOpenCallsAborted('Stream failed');
        this.#reconcileAndUpdateHistory();
      }
    }
    return this.#ledger.getRecoverySummary();
  }

  #restoreSettledEntries(snapshot: SavedToolExecution[]): void {
    const merged = [...snapshot];
    const indices = new Map(merged.map((entry, index) => [entry.callId, index]));
    for (const entry of this.#ledger.export()) {
      if (!['completed', 'aborted', 'unknown'].includes(entry.status)) continue;
      const index = indices.get(entry.callId);
      if (index !== undefined) merged[index] = entry;
      else {
        indices.set(entry.callId, merged.length);
        merged.push(entry);
      }
    }
    this.#ledger.import(merged);
  }

  reset(): void {
    this.#store.clear();
    this.#segmentBaseline = undefined;
    this.#pendingReasoningText = '';
    this.#ledger = new ToolExecutionLedger();
    this.#recoveryBaselines = { initial: [], decision: [] };
    this.#segmentSource = 'startStream';
    this.#attachUserTurnCount();
    this.#journal.clear();
  }
  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }) {
    const validated = ImportedConversationStateSchema.parse(state);
    const projected = projectImportedState(validated);
    this.reset();
    this.#ledger.import(validated.toolLedger);
    for (const item of projected.history) this.#store.addImportedItem(item);
    return { validated, projected };
  }
  removeLastUserTurn() {
    const removed = this.#store.removeLastUserTurn();
    if (removed) this.#pruneToHistory(true);
    return removed;
  }
  retryLastUserTurn() {
    const turn = this.#store.listUserTurns().at(-1);
    if (!turn) return false;
    const original = this.#store.getHistory()[turn.index]!;
    this.#store.removeLastUserTurn();
    this.#pruneToHistory(true);
    const discardedSnapshot = { history: this.#store.getHistory(), toolLedger: this.#ledger.export() };
    this.#store.addImportedItem(original);
    return { discardedSnapshot };
  }
  removeNLastUserTurns(n: number) {
    const removed = this.#store.removeNLastUserTurns(n);
    if (removed) this.#pruneToHistory(true);
    return removed;
  }
  rewindToTarget(target: RewindTargetId) {
    const removed = this.#store.rewindToTarget(target);
    if (removed) this.#pruneToHistory(true);
    return removed;
  }
  peekLastToolOutput() {
    this.#reconcileAndUpdateHistory();
    return this.#store.peekLastToolOutput();
  }
  removeAfterLastToolOutput() {
    this.#reconcileAndUpdateHistory();
    const removed = this.#store.removeAfterLastToolOutput();
    if (removed) this.#pruneToHistory(false);
    return removed;
  }
  #pruneToHistory(pruneJournal: boolean): void {
    const userCount = this.#store.listUserTurns().length;
    const ids = new Set(this.#store.getHistory().map(callIdOf).filter(Boolean));
    this.#ledger.import(
      this.#ledger.export().filter((entry) => {
        if (entry.userTurnCount !== undefined) return entry.userTurnCount <= userCount;
        const match = /^turn-(\d+)$/.exec(entry.turnId);
        return match ? Number.parseInt(match[1]!, 10) <= userCount : ids.has(entry.callId);
      }),
    );
    if (pruneJournal) this.#journal.pruneToUserTurnCount(userCount);
  }
  #deliverJournalEvent(event: LogEvent): void {
    if (!this.#journalSink) return;
    try {
      this.#journalSink(event);
      if (this.#lastPersistence !== 'failed') this.#lastPersistence = 'acknowledged';
    } catch (error) {
      this.#lastPersistence = 'failed';
      this.#logger?.warn('Journal sink threw', {
        eventType: 'conversation_log.sink_failed',
        category: 'persistence',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  #receipt(): RecordAcceptanceReceipt {
    return { accepted: 'memory', persistence: this.#lastPersistence };
  }
}
