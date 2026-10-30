import { getMethod } from '../interruption-info.js';
import { ProjectionWarningCode } from '../conversation/conversation-state-projector.js';
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
    pendingModeNotice = null;
    #inputPlanner;
    #record;
    #logger;
    #sessionId;
    #appState;
    #providerContinuity;
    #generationGuard;
    #continuityReset;
    #sessionAccess;
    #terminateActiveTurn;
    #pendingInteraction;
    #conversationLogger;
    #agentClient;
    #settingsService;
    constructor(deps) {
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
    resetSession(options) {
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
    afterProviderChanged() {
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
    #afterUndo() {
        this.#terminateActiveTurn?.();
        this.#generationGuard.invalidate();
        this.#continuityReset.reset();
        this.#inputPlanner.markUndoOrRewind();
        this.#appState.statusMachine.abort();
    }
    /**
     * Export the current session state for persistence.
     */
    exportPersistedState() {
        return this.#record.exportState(this.#providerContinuity.previousResponseId);
    }
    /**
     * Import a previously persisted session state.
     *
     * Reconciles the persisted history with the tool execution ledger,
     * clears the current store, and resets all continuity state so the
     * first resumed turn sends full history.
     */
    importPersistedState(state) {
        const { validated: validatedState, projected } = this.#record.importState(state);
        this.#terminateActiveTurn?.();
        this.#clearAccessState();
        if (projected.warnings.length > 0) {
            const addedCompletedPairs = projected.warnings.find((warning) => warning.code === ProjectionWarningCode.CompletedToolHistoryInserted)
                ?.detail?.addedCompletedPairs ?? 0;
            const droppedIncompleteCalls = projected.warnings.find((warning) => warning.code === ProjectionWarningCode.IncompleteToolHistoryDropped)
                ?.detail?.droppedIncompleteCalls ?? 0;
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
    reset() {
        this.resetSession();
    }
    // ── Undo ──────────────────────────────────────────────────────────
    reserveHistoryMutation(command) {
        const reservation = this.#record.reserveHistoryMutation(command);
        if (reservation.kind !== 'reserved')
            return reservation;
        return {
            kind: 'reserved',
            apply: () => {
                if (!reservation.consume())
                    return null;
                if (command.kind === 'undo_last')
                    return this.undoLastUserTurn();
                if (command.kind === 'undo_count')
                    return this.undoNUserTurns(command.count);
                return this.rewindToTarget(command.targetId);
            },
        };
    }
    undoLastUserTurn() {
        const removed = this.#record.removeLastUserTurn();
        if (removed === null)
            return null;
        this.#completeUndo(1);
        return removed;
    }
    /** Discard the latest attempt, retaining the exact original provider input. */
    retryLastUserTurn(options) {
        const retry = this.#record.retryLastUserTurn();
        if (!retry)
            return false;
        this.#afterUndo();
        if (options?.logUndo !== false) {
            this.#conversationLogger.log({
                type: 'undo',
                removedUserTurns: 1,
                snapshot: { ...this.getCurrentSnapshot(), ...retry.discardedSnapshot },
            });
        }
        return true;
    }
    peekLastToolOutput() {
        return this.#record.peekLastToolOutput();
    }
    retryLastToolOutput() {
        const removed = this.#record.removeAfterLastToolOutput();
        if (removed === null)
            return null;
        this.#afterUndo();
        return removed;
    }
    undoNUserTurns(n) {
        const removed = this.#record.removeNLastUserTurns(n);
        if (removed === null)
            return null;
        this.#completeUndo(n);
        return removed;
    }
    listUserTurns() {
        return this.#record.listUserTurns();
    }
    listRewindTargets() {
        return this.#record.listRewindTargets();
    }
    /**
     * Rewind through a snapshot-scoped domain target. This is the only target
     * based rewind entry point: lifecycle cleanup and undo logging happen once,
     * and only after the store accepted the target.
     */
    rewindToTarget(targetId) {
        const removed = this.#record.rewindToTarget(targetId);
        if (removed === null)
            return null;
        this.#completeUndo(removed.discardedTurns);
        return { text: removed.text, ...(removed.images ? { images: removed.images } : {}) };
    }
    // ── Snapshot / State ──────────────────────────────────────────────
    getCurrentSnapshot() {
        const providerFn = getMethod(this.#agentClient, 'getProvider');
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
    replaceHistoryAtRevision(expectedRevision, history) {
        return this.#record.replaceHistoryAtRevision(expectedRevision, history);
    }
    exportState() {
        return this.exportPersistedState();
    }
    importState(state) {
        this.importPersistedState(state);
    }
    // ── Shell context / mode notice ───────────────────────────────────
    addShellContext(historyText) {
        this.#record.addShellContext(historyText);
    }
    queueModeNotice(text) {
        // Compose instead of overwrite: a profile transition and tool-toggle
        // warnings (or several toggles in one batch) must all reach the next turn.
        const existing = this.pendingModeNotice;
        this.pendingModeNotice = existing ? `${existing}\n\n${text}` : text;
    }
    previewLargeUncachedInput(input, now = Date.now()) {
        return this.#inputPlanner.previewLargeUncachedInput(input, now, {
            pendingModeNotice: this.pendingModeNotice,
        });
    }
    previewInputSurge(input) {
        return this.#inputPlanner.previewInputSurge(input, {
            pendingModeNotice: this.pendingModeNotice,
        });
    }
    /** No await separates accepted history changes, retirement, reset and undo logging. */
    #completeUndo(count) {
        this.#afterUndo();
        this.#conversationLogger.log({ type: 'undo', removedUserTurns: count, snapshot: this.getCurrentSnapshot() });
    }
    #clearAccessState() {
        if (this.#sessionAccess) {
            this.#sessionAccess.clearTransient();
            return;
        }
    }
}
//# sourceMappingURL=session-lifecycle.js.map