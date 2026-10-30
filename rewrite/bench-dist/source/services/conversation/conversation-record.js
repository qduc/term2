import { toolOccurrenceKey, toolOccurrenceMetadata } from './tool-occurrence.js';
import { projectPersistedAssistantItemToProviderHistory } from './conversation-turn-items.js';
import { ConversationStore } from './conversation-store.js';
import { ToolExecutionLedger, callIdOf } from '../tool-execution-ledger.js';
import { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import { normalizeRunItem } from './run-item-normalizer.js';
import { selectAcceptedStreamHistory } from './conversation-record-stream.js';
import { projectProviderHistory, projectImportedState, projectSnapshot } from './conversation-state-projector.js';
import { buildToolLedgerFromJournalEvents } from './journal-to-ledger.js';
import { ImportedConversationStateSchema } from './conversation-state-schema.js';
/**
 * Sole acceptance authority for provider history, tool evidence and assistant journal.
 * Physical execution and recovery policy remain with their existing owners. All
 * reconstruction, rewind and import transitions keep these representations together.
 */
export class ConversationRecord {
    #store = new ConversationStore();
    #ledger = new ToolExecutionLedger();
    #journal;
    #logger;
    #journalSink = null;
    #segmentBaseline;
    #lastPersistence = 'unconfigured';
    #pendingReasoningText = '';
    #segmentSource = 'startStream';
    #recoveryBaselines = { initial: [], decision: [] };
    #providerContext;
    #checkpointObserver;
    constructor(options = {}) {
        this.#logger = options.logger;
        this.#providerContext = options.providerContext;
        this.#checkpointObserver = options.checkpointObserver;
        this.#attachUserTurnCount();
        this.#journal = new AssistantTurnJournal({ getCurrentTurnId: () => this.getCurrentTurnId() });
    }
    #attachUserTurnCount() {
        this.#ledger.setUserTurnCountSource(() => this.#store.listUserTurns().length);
    }
    setJournalSink(sink) {
        if (this.#journalSink === sink)
            return;
        this.#journalSink = sink;
        this.#journal.setSink(sink ? (event) => this.#deliverJournalEvent(event) : null);
        if (!sink)
            this.#lastPersistence = 'unconfigured';
    }
    /** Preserve the pre-attempt recovery baseline without exporting journal state. */
    beginAttempt() {
        this.#recoveryBaselines.initial = this.#snapshotJournal();
        this.#segmentSource = 'startStream';
    }
    /** A decision changes the segment view, never the execution position. */
    beginDecisionResolution(source = 'continueRunStream') {
        this.#recoveryBaselines.decision = this.#snapshotJournal();
        this.#segmentSource = source;
    }
    beginTurn() {
        this.#pendingReasoningText = '';
        this.#ledger.beginTurn();
        this.#journal.resetForNewTurn();
    }
    getCurrentTurnId() {
        return this.#ledger.getCurrentTurnId();
    }
    getHistory() {
        return this.#store.getHistory();
    }
    getProviderHistorySnapshot() {
        return this.#store.getProviderHistorySnapshot();
    }
    getProviderHistoryIdentity() {
        return this.#store.getProviderHistoryIdentity();
    }
    getLastUserMessage() {
        return this.#store.getLastUserMessage();
    }
    listUserTurns() {
        return this.#store.listUserTurns();
    }
    listRewindTargets() {
        return this.#store.listRewindTargets();
    }
    reserveHistoryMutation(command) {
        return this.#store.reserveHistoryMutation(command);
    }
    #snapshotJournal() {
        return structuredClone(this.#journal.getEvents());
    }
    getCurrentTurnItems() {
        return structuredClone(this.#journal.getCurrentTurnItems());
    }
    recordTextDelta(delta) {
        this.#journal.recordTextDelta(delta);
    }
    recordReasoningDelta(delta) {
        this.#pendingReasoningText += delta;
        this.#journal.recordReasoningDelta(delta);
    }
    rollbackReasoning(characters) {
        this.#pendingReasoningText = this.#pendingReasoningText.slice(0, Math.max(0, this.#pendingReasoningText.length - characters));
    }
    exportToolEvidence() {
        return structuredClone(this.#ledger.export());
    }
    activeCallIdsForCurrentTurn() {
        return this.#ledger.activeCallIdsForTurn();
    }
    completedResultCallIdsForCurrentTurn() {
        return this.#ledger.completedResultCallIdsForCurrentTurn();
    }
    unsettledToolCallIdsForCurrentTurn() {
        return this.#ledger
            .export()
            .filter((entry) => entry.turnId === this.getCurrentTurnId() &&
            (entry.status === 'started' || entry.status === 'approval_required'))
            .map((entry) => entry.callId);
    }
    inspectCommittedToolContinuation() {
        const live = this.#ledger.export().filter((entry) => entry.turnId === this.getCurrentTurnId());
        const completed = live.filter((entry) => entry.status === 'completed');
        const historyItems = this.getReconciledHistory().flatMap(normalizeRunItem);
        const historyCalls = new Set(historyItems.filter((item) => item.type === 'tool_call').map(toolOccurrenceKey));
        const historyResults = new Set(historyItems.filter((item) => item.type === 'tool_result').map(toolOccurrenceKey));
        return {
            completedToolCount: completed.length,
            allToolsCompleted: live.length > 0 && live.every((entry) => entry.status === 'completed'),
            completedPairsPresentInHistory: completed.every((entry) => historyCalls.has(toolOccurrenceKey(entry)) && historyResults.has(toolOccurrenceKey(entry))),
        };
    }
    acceptInput(turn) {
        this.#store.addUserTurn(turn);
        return { accepted: 'memory', persistence: 'not_requested' };
    }
    addUserTurn(turn) {
        return this.acceptInput(turn);
    }
    removeLastUserMessage() {
        this.#store.removeLastUserMessage();
    }
    addShellContext(text) {
        this.#store.addShellContext(text);
    }
    markDispatched(callId) {
        this.#ledger.markDispatched(callId);
    }
    recordFunctionCall(item) {
        this.#ledger.recordFunctionCall(item);
    }
    recordFunctionResult(item) {
        this.#ledger.recordFunctionResult(item);
    }
    recordAbortedApproval(output, error, callId) {
        this.#ledger.recordAbortedApproval(output, error, callId);
    }
    markOpenCallsAborted(error, callId) {
        this.#ledger.markOpenCallsAborted(error, callId);
    }
    getRecoverySummary() {
        return this.#ledger.getRecoverySummary();
    }
    /** A segment is a wire view over the same record, not another acceptance owner. */
    beginSegment() {
        this.#segmentBaseline = this.#store.getProviderHistorySnapshot();
        this.#pendingReasoningText = '';
    }
    /** Accept one observed provider item into both evidence representations before publication. */
    acceptObservedItem(item) {
        this.#lastPersistence = this.#journalSink ? 'not_requested' : 'unconfigured';
        // Journal deduplication is independent of execution occurrence: a real new
        // invocation may reuse a provider call id within this logical turn.
        const acceptedItems = normalizeRunItem(item);
        for (const normalized of acceptedItems) {
            if (normalized.type === 'tool_call') {
                if (this.#pendingReasoningText)
                    this.#ledger.recordReasoningText(this.#pendingReasoningText);
                this.#pendingReasoningText = '';
                const entry = this.#ledger.recordFunctionCall(normalized);
                if (entry)
                    Object.assign(normalized, toolOccurrenceMetadata(entry));
            }
            else if (normalized.type === 'tool_result') {
                const entry = this.#ledger.recordFunctionResult(normalized);
                if (entry)
                    Object.assign(normalized, toolOccurrenceMetadata(entry));
                if (this.#segmentSource !== 'startStream' && this.#journalSink) {
                    this.#deliverJournalEvent({
                        type: 'tool_result',
                        ...toolOccurrenceMetadata(normalized),
                        callId: normalized.callId,
                        toolName: entry?.toolName ?? normalized.toolName,
                        status: entry?.status === 'failed' || entry?.status === 'aborted' || entry?.status === 'unknown'
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
        const journalItems = this.#journal.recordRunItem(item, acceptedItems);
        if (journalItems.length)
            this.#store.appendOutput(journalItems.some((accepted) => accepted.type === 'tool_call' || accepted.type === 'tool_result')
                ? journalItems.map(projectPersistedAssistantItemToProviderHistory)
                : [item]);
        else if (!acceptedItems.length)
            this.#store.appendOutput([item]);
        return this.#receipt();
    }
    /** Accept a completed or interrupted execution view, independent of rendering. */
    acceptSegment(stream, inputMode, diagnostics) {
        const selected = selectAcceptedStreamHistory({
            stream,
            toolLedger: this.#ledger.export(),
            history: this.#segmentBaseline ? [...this.#segmentBaseline.history] : this.#store.getHistory(),
            inputMode,
            source: this.#segmentSource,
            ...diagnostics,
        });
        const before = this.#segmentBaseline?.revision ?? this.#store.getProviderHistoryIdentity().revision;
        if (selected.history)
            this.#store.replaceHistory(selected.history);
        const snapshot = this.#store.getProviderHistorySnapshot();
        const accepted = {
            kind: selected.terminal ? 'committed' : 'partial',
            snapshot,
            historyCommitted: snapshot.revision !== before,
            lastResponseId: selected.lastResponseId,
            unsettledToolCallIds: this.unsettledToolCallIdsForCurrentTurn(),
            ...(selected.compactionEvidence ? { compactionEvidence: selected.compactionEvidence } : {}),
        };
        this.#providerContext?.acceptSegment(accepted, this.#checkpointObserver);
        return accepted;
    }
    snapshot(metadata) {
        return projectSnapshot({ ...metadata, history: this.#store.getHistory(), toolLedger: this.#ledger.export() });
    }
    exportState(previousResponseId) {
        return { history: this.getReconciledHistory(), previousResponseId, toolLedger: this.#ledger.export() };
    }
    getReconciledHistory() {
        return projectProviderHistory({ history: this.#store.getHistory(), toolLedger: this.#ledger.export() }).history;
    }
    #reconcileAndUpdateHistory() {
        const projected = projectProviderHistory({ history: this.#store.getHistory(), toolLedger: this.#ledger.export() });
        if (!projected.warnings.length)
            return false;
        this.#store.replaceHistory(projected.history);
        return true;
    }
    /** Conditional compaction acceptance preserves the existing transcript revision guard. */
    replaceHistoryAtRevision(revision, history) {
        return this.#store.replaceHistoryAtRevision(revision, history);
    }
    /** Apply a policy-selected recovery transition without exposing representation precedence. */
    recover(plan, state) {
        const snapshot = buildToolLedgerFromJournalEvents(this.#recoveryBaselines[state.baseline], new Date().toISOString());
        if (plan.kind === 'replay_turn') {
            this.#ledger.import(snapshot);
            if (plan.rollbackUserMessage)
                this.#store.removeLastUserMessage();
            if (plan.errorContext)
                this.#store.addErrorContext(plan.errorContext);
        }
        else if (plan.kind === 'retry_fresh') {
            if (state.stream)
                this.#ledger.settleOpenCallsOnStreamFailure('Stream failed');
            this.#restoreSettledEntries(snapshot);
            if (state.stream)
                this.#reconcileAndUpdateHistory();
        }
        else {
            if (state.addedUserMessage && !state.stream)
                this.#store.removeLastUserMessage();
            if (state.stream) {
                this.#ledger.settleOpenCallsOnStreamFailure('Stream failed');
                this.#ledger.markOpenCallsAborted('Stream failed');
                this.#reconcileAndUpdateHistory();
            }
        }
        return this.#ledger.getRecoverySummary();
    }
    #restoreSettledEntries(snapshot) {
        const merged = [...snapshot];
        const indices = new Map(merged.map((entry, index) => [toolOccurrenceKey(entry), index]));
        for (const entry of this.#ledger.export()) {
            if (!['completed', 'aborted', 'unknown'].includes(entry.status))
                continue;
            const index = indices.get(toolOccurrenceKey(entry));
            if (index !== undefined)
                merged[index] = entry;
            else {
                indices.set(toolOccurrenceKey(entry), merged.length);
                merged.push(entry);
            }
        }
        this.#ledger.import(merged);
    }
    reset() {
        this.#store.clear();
        this.#segmentBaseline = undefined;
        this.#pendingReasoningText = '';
        this.#ledger = new ToolExecutionLedger();
        this.#recoveryBaselines = { initial: [], decision: [] };
        this.#segmentSource = 'startStream';
        this.#attachUserTurnCount();
        this.#journal.clear();
    }
    importState(state) {
        const validated = ImportedConversationStateSchema.parse(state);
        this.reset();
        this.#ledger.import(validated.toolLedger);
        const projected = projectImportedState({ ...validated, toolLedger: this.#ledger.export() });
        for (const item of projected.history)
            this.#store.addImportedItem(item);
        return { validated, projected };
    }
    removeLastUserTurn() {
        const removed = this.#store.removeLastUserTurn();
        if (removed)
            this.#pruneToHistory(true);
        return removed;
    }
    retryLastUserTurn() {
        const turn = this.#store.listUserTurns().at(-1);
        if (!turn)
            return false;
        const original = this.#store.getHistory()[turn.index];
        this.#store.removeLastUserTurn();
        this.#pruneToHistory(true);
        const discardedSnapshot = { history: this.#store.getHistory(), toolLedger: this.#ledger.export() };
        this.#store.addImportedItem(original);
        return { discardedSnapshot };
    }
    removeNLastUserTurns(n) {
        const removed = this.#store.removeNLastUserTurns(n);
        if (removed)
            this.#pruneToHistory(true);
        return removed;
    }
    rewindToTarget(target) {
        const removed = this.#store.rewindToTarget(target);
        if (removed)
            this.#pruneToHistory(true);
        return removed;
    }
    peekLastToolOutput() {
        this.#reconcileAndUpdateHistory();
        return this.#store.peekLastToolOutput();
    }
    removeAfterLastToolOutput() {
        this.#reconcileAndUpdateHistory();
        const removed = this.#store.removeAfterLastToolOutput();
        if (removed)
            this.#pruneToHistory(false);
        return removed;
    }
    #pruneToHistory(pruneJournal) {
        const userCount = this.#store.listUserTurns().length;
        const ids = new Set(this.#store.getHistory().map(callIdOf).filter(Boolean));
        this.#ledger.import(this.#ledger.export().filter((entry) => {
            if (entry.userTurnCount !== undefined)
                return entry.userTurnCount <= userCount;
            const match = /^turn-(\d+)$/.exec(entry.turnId);
            return match ? Number.parseInt(match[1], 10) <= userCount : ids.has(entry.callId);
        }));
        if (pruneJournal)
            this.#journal.pruneToUserTurnCount(userCount);
    }
    #deliverJournalEvent(event) {
        if (!this.#journalSink)
            return;
        try {
            this.#journalSink(event);
            if (this.#lastPersistence !== 'failed')
                this.#lastPersistence = 'acknowledged';
        }
        catch (error) {
            this.#lastPersistence = 'failed';
            this.#logger?.warn('Journal sink threw', {
                eventType: 'conversation_log.sink_failed',
                category: 'persistence',
                errorMessage: error instanceof Error ? error.message : String(error),
            });
        }
    }
    #receipt() {
        return { accepted: 'memory', persistence: this.#lastPersistence };
    }
}
//# sourceMappingURL=conversation-record.js.map