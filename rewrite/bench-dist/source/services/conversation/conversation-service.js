import { createCallerOwnedSessionClientFactory, } from '../session/session-client-factory.js';
import { createConversationRuntime } from './conversation-runtime-factory.js';
import { primeActiveProfileNoticeIfActive } from '../mode-notices.js';
import { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
import { isClassifiedCancellation } from '../retry/provider-failure-classification.js';
/**
 * Backward-compatible facade for the CLI.
 *
 * Phase 3: the session owns the conversation state; the service is a thin wrapper.
 */
export class ConversationService {
    #runtime;
    #rolloverQueueBoundaryEnabled = false;
    #reservedRollover = null;
    #settledRollover = null;
    #adapter;
    #sessionHandle;
    #clientHandle;
    #clientFactory;
    #toolCallMarkers;
    #queueCapacity;
    #preparedLeaseTtlMs;
    #activeCancelTimeoutMs;
    #discardOnFailure;
    #enableNestedApproval;
    #automaticMemory;
    #eventSink = null;
    #pendingInteractionObserver = null;
    #nestedApprovalObserver = null;
    #deps;
    constructor({ agentClient, sessionClientFactory, deps, sessionId = 'default', sessionStartedAt, toolOwnership, toolCallMarkers, queueCapacity, preparedLeaseTtlMs, activeCancelTimeoutMs, discardOnFailure, enableNestedApproval, automaticMemory, }) {
        if (!sessionClientFactory && !agentClient) {
            throw new Error('ConversationService requires an agentClient or sessionClientFactory');
        }
        if (!sessionClientFactory && !toolOwnership) {
            throw new Error('ConversationService requires toolOwnership with an agentClient');
        }
        this.#clientFactory = sessionClientFactory ?? createCallerOwnedSessionClientFactory(agentClient, toolOwnership);
        this.#queueCapacity = queueCapacity;
        this.#preparedLeaseTtlMs = preparedLeaseTtlMs;
        this.#activeCancelTimeoutMs = activeCancelTimeoutMs;
        this.#discardOnFailure = discardOnFailure === true;
        this.#enableNestedApproval = enableNestedApproval === true;
        this.#automaticMemory = automaticMemory;
        const resolvedSessionStartedAt = sessionStartedAt ?? new Date().toISOString();
        this.#clientHandle = this.#clientFactory.create(sessionId ?? 'default', {
            sessionStartedAt: resolvedSessionStartedAt,
        });
        this.#toolCallMarkers = toolCallMarkers ?? new ToolCallMarkerStore();
        this.#deps = deps;
        const { runtime, adapter } = createConversationRuntime({
            agentClient: this.#clientHandle.agentClient,
            providerContinuity: this.#clientHandle.providerContinuity,
            openAIRootCheckpointLifecycleObserver: this.#clientHandle.openAIRootCheckpointLifecycleObserver,
            toolOwnership: this.#clientHandle.toolOwnership,
            postExecutePending: this.#clientHandle.postExecutePending,
            postExecutePauseCapability: this.#clientHandle.postExecutePauseCapability,
            ...(this.#clientHandle.access ? { sessionAccess: this.#clientHandle.access } : {}),
            automaticMemory: this.#automaticMemory,
            ...(this.#clientHandle.hookLifecycle ? { hookLifecycle: this.#clientHandle.hookLifecycle } : {}),
            ...(this.#clientHandle.hookEvents ? { hookEvents: this.#clientHandle.hookEvents } : {}),
            toolCallMarkers: this.#toolCallMarkers,
            sessionIdentity: this.#clientHandle.sessionIdentity,
            deps,
            queueForeground: true,
            queueCapacity,
            preparedLeaseTtlMs,
            activeCancelTimeoutMs,
            discardOnFailure: this.#discardOnFailure,
            sessionId: sessionId ?? 'default',
            sessionStartedAt: resolvedSessionStartedAt,
            enableNestedApproval: this.#enableNestedApproval,
        });
        this.#runtime = runtime;
        this.#adapter = adapter;
        this.#attachRolloverQueueBoundary();
        const service = this;
        this.#sessionHandle = {
            get sessionId() {
                return service.sessionId;
            },
            get sessionStartedAt() {
                return service.sessionStartedAt;
            },
            prepare: (input, ids) => service.prepareMessage(input, ids),
            commit: (leaseId) => service.commitMessage(leaseId),
            cancelPrepared: (leaseId) => service.cancelPreparedMessage(leaseId),
            resolveInteraction: (request) => service.resolvePendingInteraction(request),
            snapshot: () => service.getCurrentSnapshot(),
            setEventSink: (sink) => service.setEventSink(sink),
            setQueuedTurnStartObserver: (observer) => service.setQueuedTurnStartObserver(observer),
            closeAdmission: () => {
                service.closeAdmission();
            },
            reopenAdmission: () => {
                service.reopenAdmission();
            },
            abortAndDiscard: () => service.abortAndDiscard(),
            shutdown: () => service.shutdown(),
        };
        if (this.#deps.settingsService) {
            primeActiveProfileNoticeIfActive(this.#deps.settingsService, (text) => this.queueModeNotice(text));
        }
    }
    setEventSink(sink) {
        this.#eventSink = sink;
        this.#adapter.setEventSink(sink);
    }
    #backgroundSubagentNotificationObserver = null;
    #backgroundSubagentTaskObserver = null;
    #backgroundSubagentEventSink = null;
    /**
     * Observe background (async) subagent runs settling. The observer fires once
     * per newly queued completion; the queued notifications themselves are read
     * through {@link backgroundSubagentNotifications}.
     */
    setBackgroundSubagentNotificationObserver(observer) {
        this.#backgroundSubagentNotificationObserver = observer;
        this.#runtime.backgroundSubagentNotifications.setObserver(observer);
    }
    /** Completions of background subagent runs still owed to the main agent. */
    get backgroundSubagentNotifications() {
        return this.#runtime.backgroundSubagentNotifications;
    }
    setBackgroundSubagentTaskObserver(observer) {
        this.#backgroundSubagentTaskObserver = observer;
        this.#runtime.backgroundSubagentTasks.setObserver(observer);
    }
    /** Current running and briefly retained terminal background tasks. */
    get backgroundSubagentTasks() {
        return this.#runtime.backgroundSubagentTasks;
    }
    /** Details and stop requests for conversation-owned background work. */
    get backgroundTaskControl() {
        return this.#runtime.backgroundTaskControl;
    }
    get backgroundSubagentApprovals() {
        return this.#runtime.backgroundSubagentApprovals;
    }
    setBackgroundSubagentEventSink(sink) {
        this.#backgroundSubagentEventSink = sink;
        this.#runtime.sinks.subagentEvents?.setBackgroundSubagentEventSink?.(sink);
    }
    answerBackgroundSubagentQuestion(runId, messageId, answer) {
        return this.#clientHandle.agentClient.answerBackgroundSubagentQuestion?.(runId, messageId, answer) === true;
    }
    /** Stable public identity; internal context rollovers do not rebind clients. */
    get sessionId() {
        return this.#runtime.publicSessionId;
    }
    get sessionStartedAt() {
        return this.#runtime.publicSessionStartedAt;
    }
    /** The gateway-facing projection over this service's already-built runtime. */
    get sessionHandle() {
        return this.#sessionHandle;
    }
    getUnsettledToolExecutions() {
        return this.#runtime.getUnsettledToolExecutions();
    }
    get hookEvents() {
        return this.#clientHandle.hookEvents;
    }
    async shutdown() {
        await this.#runtime.shutdown();
        this.#clientHandle.dispose();
    }
    resetWithNewId(newId) {
        const previousLogSink = this.#logSink;
        const previousEventSink = this.#eventSink;
        const previousRuntime = this.#runtime;
        const previousClient = this.#clientHandle.agentClient;
        // A reset replaces the session; pending queue work belongs to the session
        // being replaced. Discard it (in memory and in persistence) so the dropped
        // adapter can never start a queued submission after the reset — otherwise
        // a /clear with queued messages sends them afterward.
        void this.#adapter.discardQueue();
        this.#runtime.state.reset();
        this.#runtime.dispose();
        this.#clientHandle.dispose();
        this.#deps.skillsService?.discoverSkills();
        const newSessionStartedAt = new Date().toISOString();
        this.#clientHandle = this.#clientFactory.create(newId, { sessionStartedAt: newSessionStartedAt });
        if (this.#clientHandle.agentClient === previousClient) {
            // A reused client's callbacks now belong to the replacement. The old
            // runtime still settles its work, but must not detach these callbacks.
            previousRuntime.relinquishBackgroundSinkOwnership();
        }
        const { runtime, adapter } = createConversationRuntime({
            agentClient: this.#clientHandle.agentClient,
            providerContinuity: this.#clientHandle.providerContinuity,
            openAIRootCheckpointLifecycleObserver: this.#clientHandle.openAIRootCheckpointLifecycleObserver,
            toolOwnership: this.#clientHandle.toolOwnership,
            postExecutePending: this.#clientHandle.postExecutePending,
            postExecutePauseCapability: this.#clientHandle.postExecutePauseCapability,
            ...(this.#clientHandle.access ? { sessionAccess: this.#clientHandle.access } : {}),
            automaticMemory: this.#automaticMemory,
            ...(this.#clientHandle.hookLifecycle ? { hookLifecycle: this.#clientHandle.hookLifecycle } : {}),
            ...(this.#clientHandle.hookEvents ? { hookEvents: this.#clientHandle.hookEvents } : {}),
            toolCallMarkers: this.#toolCallMarkers,
            sessionIdentity: this.#clientHandle.sessionIdentity,
            deps: this.#deps,
            queueForeground: true,
            queueCapacity: this.#queueCapacity,
            preparedLeaseTtlMs: this.#preparedLeaseTtlMs,
            activeCancelTimeoutMs: this.#activeCancelTimeoutMs,
            discardOnFailure: this.#discardOnFailure,
            sessionId: newId,
            sessionStartedAt: newSessionStartedAt,
            enableNestedApproval: this.#enableNestedApproval,
        });
        this.#runtime = runtime;
        this.#adapter = adapter;
        this.#attachRolloverQueueBoundary();
        if (previousLogSink) {
            this.#runtime.logs.setLogSink(previousLogSink);
        }
        if (previousEventSink) {
            this.#adapter.setEventSink(previousEventSink);
        }
        // The previous runtime's notification queue died with it; re-attach the
        // observers so the new conversation still wakes and updates its overview.
        this.#runtime.backgroundSubagentNotifications.setObserver(this.#backgroundSubagentNotificationObserver);
        this.#runtime.backgroundSubagentTasks.setObserver(this.#backgroundSubagentTaskObserver);
        this.#runtime.sinks.subagentEvents?.setBackgroundSubagentEventSink?.(this.#backgroundSubagentEventSink);
        this.#runtime.pendingInteraction.setObserver(this.#pendingInteractionObserver);
        this.#runtime.nestedApproval.subscribe(this.#nestedApprovalObserver);
        // The new adapter starts with no observers; re-attach the queue lifecycle
        // observers so queued submissions still notify their UI after a reset.
        if (this.#queueStateObserver) {
            this.#adapter.setQueueStateObserver(this.#queueStateObserver);
        }
        if (this.#queuedTurnStartObserver) {
            this.#adapter.setQueuedTurnStartObserver(this.#queuedTurnStartObserver);
        }
        // The replacement factory-owned client never saw the retry callback;
        // re-install it so retries keep surfacing through the same hook.
        if (this.#retryCallback) {
            this.#runtime.settings.setRetryCallback(this.#retryCallback);
        }
        if (this.#deps.settingsService) {
            primeActiveProfileNoticeIfActive(this.#deps.settingsService, (text) => this.queueModeNotice(text));
        }
    }
    /** Validate rollover admission without changing state or external persistence. */
    prepareRolloverWithNewId(newId, sessionStartedAt) {
        if (!newId)
            throw new Error('Session rollover requires a session ID.');
        if (this.#reservedRollover?.cancelled)
            throw new Error('Session rollover was cancelled.');
        this.#assertRolloverAdmission();
        // Runtime admission is part of this preflight too. Its returned callback
        // performs only the synchronous state transition, with no later rejection
        // point after an external writer has committed.
        return this.#runtime.prepareRollover(newId, sessionStartedAt);
    }
    /** Rollover-only identity/context reset; ordinary clear keeps its disposal semantics. */
    rolloverWithNewId(newId, sessionStartedAt) {
        this.prepareRolloverWithNewId(newId, sessionStartedAt)();
    }
    #assertRolloverAdmission() {
        if (this.#hasPendingRolloverInteraction()) {
            throw new Error('Session rollover is blocked while a user interaction or approval is pending.');
        }
    }
    #hasPendingRolloverInteraction() {
        const interaction = this.#runtime.pendingInteraction.getSnapshot();
        const backgroundWaitingForAnswer = this.#runtime.backgroundTaskControl
            .listDetails()
            .some((detail) => detail.kind === 'subagent' &&
            (detail.status === 'awaiting_approval' || detail.status === 'waiting_for_answer'));
        // A stale ordinary interaction projection does not veto a settled turn;
        // check-ins have no backing approval owner and therefore remain authoritative.
        return (interaction?.approval.checkIn !== undefined ||
            this.#runtime.approval.getPending() !== null ||
            this.#runtime.approval.getPostExecutePending().entries.length > 0 ||
            this.#runtime.backgroundSubagentApprovals.getSnapshot().pendingCount > 0 ||
            this.#runtime.nestedApproval.getSnapshot() !== null ||
            backgroundWaitingForAnswer);
    }
    #logSink = null;
    setLogSink(sink) {
        this.#logSink = sink;
        this.#runtime.logs.setLogSink(sink);
    }
    getCurrentSnapshot() {
        return this.#runtime.state.getCurrentSnapshot();
    }
    undoLastUserTurn() {
        return this.#runtime.state.undoLastUserTurn();
    }
    listUserTurns() {
        return this.#runtime.state.listUserTurns();
    }
    /**
     * Every turn the conversation can be rewound to, annotated with what
     * rewinding there would discard. Drives the `/rewind` picker's cost preview.
     */
    listRewindTargets() {
        return this.#runtime.state.listRewindTargets();
    }
    rewindToTarget(targetId) {
        return this.#runtime.state.rewindToTarget(targetId);
    }
    undoNUserTurns(n) {
        return this.#runtime.state.undoNUserTurns(n);
    }
    peekLastToolOutput() {
        return this.#runtime.state.peekLastToolOutput();
    }
    setModelSelection(selection) {
        this.#runtime.settings.setModelSelection(selection);
    }
    setReasoningEffort(effort) {
        this.#runtime.settings.setReasoningEffort(effort);
    }
    setTemperature(temperature) {
        this.#runtime.settings.setTemperature(temperature);
    }
    #retryCallback = null;
    setRetryCallback(callback) {
        this.#retryCallback = callback;
        this.#runtime.settings.setRetryCallback(callback);
    }
    /**
     * Record what the user did in shell mode so the agent can see it.
     *
     * While a turn is running the store is the wrong destination: the turn holds
     * its own transcript and overwrites the store when it commits, which drops
     * anything appended underneath it. Hand it to the turn instead, and fall
     * back to the store only when no turn will take it.
     */
    addShellContext(historyText) {
        if (!historyText.trim())
            return;
        void this.#adapter
            .injectIntoActiveTurn([{ type: 'message', role: 'user', content: historyText }])
            .catch(() => false)
            .then((injected) => {
            if (!injected)
                this.#runtime.state.addShellContext(historyText);
        });
    }
    queueModeNotice(text) {
        this.#runtime.state.queueModeNotice(text);
    }
    /** Install the interactive turn-end consumer's queue reservation. Headless callers do not reserve. */
    setRolloverQueueBoundary(enabled) {
        this.#rolloverQueueBoundaryEnabled = enabled;
        if (!enabled && this.#reservedRollover) {
            this.finishSessionRollover(this.#reservedRollover.rolloverId, { pauseIfQueued: true });
        }
    }
    #attachRolloverQueueBoundary() {
        this.#adapter.setBeforeQueueAdvance(() => {
            if (!this.#rolloverQueueBoundaryEnabled)
                return;
            const consumption = this.consumeSessionRolloverRequest();
            if (consumption.status === 'none')
                return;
            this.#settledRollover = consumption;
            if (consumption.status === 'ready' && this.#adapter.holdForegroundQueue({ afterCompletion: true })) {
                this.#reservedRollover = { rolloverId: consumption.request.rolloverId, cancelled: false };
            }
        });
    }
    /** Settle only this handoff's hold; failed/cancelled handoffs retain input for manual resume. */
    finishSessionRollover(rolloverId, options = {}) {
        if (this.#reservedRollover?.rolloverId !== rolloverId)
            return;
        const cancelled = this.#reservedRollover.cancelled;
        this.#reservedRollover = null;
        this.#adapter.releaseForegroundQueue({ pauseIfQueued: options.pauseIfQueued || cancelled });
    }
    consumeSessionRolloverRequest() {
        if (this.#settledRollover) {
            const consumption = this.#settledRollover;
            this.#settledRollover = null;
            return consumption;
        }
        const consumption = this.#clientHandle.agentClient.consumeSessionRolloverRequest?.() ?? { status: 'none' };
        if (consumption.status === 'blocked') {
            this.#logBlockedRollover(consumption);
            return consumption;
        }
        if (consumption.status !== 'ready')
            return consumption;
        if (!this.#hasPendingRolloverInteraction())
            return consumption;
        const error = 'Session rollover was not performed because a user interaction is pending.';
        this.#runtime.state.queueModeNotice(error);
        const blocked = {
            status: 'blocked',
            blocker: 'pending_interaction',
            error,
            request: consumption.request,
        };
        this.#logBlockedRollover(blocked);
        return blocked;
    }
    logSessionRollover(event) {
        this.#runtime.logs.log(event);
    }
    #logBlockedRollover(consumption) {
        const { request } = consumption;
        this.logSessionRollover({
            type: 'session_rollover',
            phase: 'blocked',
            rolloverId: request.rolloverId,
            sourceSessionId: this.#runtime.sessionId,
            ...(request.reason ? { reason: request.reason } : {}),
            briefSize: request.brief.length,
            ...(request.providerInputTokens !== undefined ? { providerInputTokens: request.providerInputTokens } : {}),
            blocker: consumption.blocker,
            settlementLatencyMs: Math.max(0, Date.now() - request.requestedAt),
        });
    }
    /**
     * Abort the in-flight turn. Background (async) subagent runs are
     * conversation-bound and survive this; they are only stopped by
     * {@link interruptFromUser}, disposal, or shutdown.
     */
    abort() {
        if (this.#reservedRollover)
            this.#reservedRollover.cancelled = true;
        this.#adapter.abort();
    }
    /**
     * Abort the in-flight turn *and* cancel conversation-bound background
     * subagent runs, because the user explicitly asked everything to stop.
     */
    interruptFromUser() {
        this.abort();
        this.#clientHandle.agentClient.cancelBackgroundRuns?.();
        this.#clientHandle.agentClient.cancelBackgroundShellJobs?.();
    }
    /** Reserve a gateway message slot without starting provider/tool work. */
    prepareMessage(input, ids) {
        return this.#adapter.prepareMessage(input, ids);
    }
    commitMessage(leaseId) {
        return this.#adapter.commitMessage(leaseId);
    }
    cancelPreparedMessage(leaseId) {
        return this.#adapter.cancelPreparedMessage(leaseId);
    }
    abortAndDiscard() {
        return this.#adapter.abortAndDiscard();
    }
    /** Prepare a lossless text-only restart without replacing or disposing this session. */
    async prepareRestart() {
        const adapter = this.#adapter;
        const release = await adapter.prepareRestart();
        if (this.#adapter !== adapter) {
            release();
            throw new Error('The conversation changed while preparing restart; try again.');
        }
        return release;
    }
    closeAdmission() {
        return this.#adapter.closeAdmission();
    }
    reopenAdmission() {
        this.#adapter.reopenAdmission();
    }
    consumeFailureDiscardedTurnIds() {
        return this.#adapter.consumeFailureDiscardedTurnIds();
    }
    /** Release the current runtime and, when factory-owned, its session client. */
    dispose() {
        this.#adapter.closeAdmission();
        this.#runtime.dispose();
        this.#clientHandle.dispose();
    }
    submitMessage(...args) {
        if (args[1]?.rolloverBrief && (!this.#reservedRollover || this.#reservedRollover.cancelled)) {
            return Promise.reject(new Error('Session rollover briefing has no active queue reservation.'));
        }
        return this.#adapter.submitMessage(...args);
    }
    sendMessage(input, options) {
        return this.#adapter.sendMessage(input, options);
    }
    async compactContext() {
        return (await this.compactContextDetailed()).message;
    }
    /** Typed manual compaction; compactContext() projects this to its display message. */
    async compactContextDetailed() {
        const startedAt = Date.now();
        const provider = () => this.#deps.settingsService?.get('agent.modelSelection').provider ?? 'openai';
        // Invariant (contract 13 §8): every context_compaction_started frame is
        // followed by exactly one terminal frame, and the command response agrees
        // in kind with that terminal frame. The runtime invokes onStarted exactly
        // when it commits to compacting — after every pre-start refusal (busy,
        // no_complete_cold_turn) has been decided — so a refusal produces no
        // frames at all and the response is nothing_to_compact.
        let startedFramePublished = false;
        const journalStarted = async () => {
            startedFramePublished = true;
            await this.#eventSink?.({
                type: 'context_compaction_started',
                provider: provider(),
                sessionId: this.sessionId,
                strategy: 'local',
            });
        };
        const journalFailure = async (errorCategory) => {
            await this.#eventSink?.({
                type: 'context_compaction_failed',
                provider: provider(),
                sessionId: this.sessionId,
                errorCategory,
                durationMs: Date.now() - startedAt,
                strategy: 'local',
            });
        };
        const failed = (message, reason) => {
            // A compaction that did not compact must be visible in the session log with
            // its typed reason; the journaled event alone carries no cause.
            this.#deps.logger.warn('Manual context compaction failed', {
                eventType: 'context_compaction.failed',
                sessionId: this.sessionId,
                reason,
            });
            return { kind: 'failed', message, reason };
        };
        if (!this.#adapter.holdForegroundQueue()) {
            return {
                kind: 'nothing_to_compact',
                message: 'Context compaction is available only while the conversation is idle.',
            };
        }
        const abort = new AbortController();
        this.#adapter.attachCompactionAbort(abort);
        try {
            const outcome = await this.#runtime.compactContext({ signal: abort.signal, onStarted: journalStarted });
            if (outcome.kind === 'busy') {
                return {
                    kind: 'nothing_to_compact',
                    message: 'Context compaction is available only while the conversation is idle.',
                };
            }
            if (outcome.kind === 'stale')
                throw new Error('Conversation changed while context compaction was running');
            if (outcome.kind === 'blocked') {
                if (outcome.reason === 'no_complete_cold_turn') {
                    return {
                        kind: 'nothing_to_compact',
                        message: 'Nothing to compact: at least one complete cold turn is required.',
                    };
                }
                await journalFailure('validation');
                return failed(`Context compaction was blocked: ${outcome.reason}.`, outcome.reason);
            }
            if (outcome.kind === 'failed') {
                // A codex native compaction failure is a provider-request failure, not a
                // local validation problem, and must not borrow a size reason.
                await journalFailure('request');
                return failed('Native context compaction failed.', 'native_failed');
            }
            if (outcome.kind === 'not_needed') {
                // Codex reported the native compaction unavailable ('unchanged', the
                // model's compactHistory hook is missing). That is a started compaction
                // whose result did not compact, so it fails with its own typed reason
                // instead of reading as "nothing to compact".
                await journalFailure('request');
                return failed('Native context compaction is unavailable for this model.', 'native_unavailable');
            }
            if (outcome.kind === 'deferred') {
                // Automatic-scheduling refusals never reach a manual compaction today;
                // if one ever does it is a started compaction that did not compact.
                await journalFailure('request');
                return failed('Context compaction was deferred.', 'deferred');
            }
            if (outcome.usage.inputTokens > 0 || outcome.usage.outputTokens > 0) {
                await this.#eventSink?.({
                    type: 'usage_update',
                    usage: {
                        prompt_tokens: outcome.usage.inputTokens,
                        completion_tokens: outcome.usage.outputTokens,
                        total_tokens: outcome.usage.inputTokens + outcome.usage.outputTokens,
                    },
                });
            }
            for (const record of outcome.costRecords)
                await this.#eventSink?.({ type: 'cost_update', record });
            await this.#eventSink?.({
                type: 'context_compaction_completed',
                provider: this.#deps.settingsService?.get('agent.modelSelection').provider ?? 'openai',
                sessionId: this.sessionId,
                inputTokensBefore: outcome.checkpoint.contextSummary.estimatedTokensBefore,
                inputTokensAfter: outcome.checkpoint.contextSummary.estimatedTokensAfter,
                durationMs: Date.now() - startedAt,
                strategy: 'local',
            });
            return {
                kind: 'compacted',
                message: `Context compacted locally (${outcome.checkpoint.contextSummary.estimatedTokensBefore ?? '?'} → ${outcome.checkpoint.contextSummary.estimatedTokensAfter ?? '?'} estimated tokens).`,
                ...(outcome.checkpoint.contextSummary.estimatedTokensBefore !== undefined
                    ? { tokensBefore: outcome.checkpoint.contextSummary.estimatedTokensBefore }
                    : {}),
                ...(outcome.checkpoint.contextSummary.estimatedTokensAfter !== undefined
                    ? { tokensAfter: outcome.checkpoint.contextSummary.estimatedTokensAfter }
                    : {}),
            };
        }
        catch (error) {
            // A throw before the runtime committed (e.g. the manual threshold is
            // unconfigured for an uncatalogued model) never published the start
            // frame, so it must not strand a terminal frame either — the RPC error
            // itself reports the failure.
            if (startedFramePublished) {
                if (abort.signal.aborted || isClassifiedCancellation(error)) {
                    await journalFailure('request');
                    return failed('Context compaction cancelled.', 'cancelled');
                }
                await journalFailure('request');
            }
            throw error;
        }
        finally {
            this.#adapter.detachCompactionAbort(abort);
            this.#adapter.releaseForegroundQueue({ pauseIfQueued: abort.signal.aborted });
        }
    }
    /** Resume foreground messages retained after an execution failure or abort. */
    resumeQueue() {
        return this.#adapter.resumeQueue();
    }
    /** Discard all queued foreground messages without executing them. */
    discardQueue() {
        return this.#adapter.discardQueue();
    }
    retractSubmission(id) {
        return this.#adapter.retractSubmission(id);
    }
    editSubmission(id, turn) {
        return this.#adapter.editSubmission(id, turn);
    }
    /**
     * Grants one bounded continuation increment to the currently running root budget.
     *
     * This is the human-answered prompt path, so the grant is not subject to the
     * parent cap. Unattended continuations take a capped grant inside the loop.
     */
    grantRunBudgetExtension() {
        return this.#clientHandle.agentClient.grantRunBudgetExtension?.() ?? { granted: false, extensionsGranted: 0 };
    }
    getPendingInteractionSnapshot() {
        return this.#runtime.pendingInteraction.getSnapshot();
    }
    setPendingInteractionObserver(observer) {
        this.#pendingInteractionObserver = observer;
        this.#runtime.pendingInteraction.setObserver(observer);
    }
    resolvePendingInteraction(request) {
        return this.#runtime.pendingInteraction.resolve(request);
    }
    presentPendingInteraction(approval) {
        return this.#runtime.pendingInteraction.present(approval);
    }
    clearPendingInteraction() {
        this.#runtime.pendingInteraction.clear();
    }
    goToPreviousPendingInteractionQuestion() {
        this.#runtime.pendingInteraction.goToPreviousQuestion();
    }
    goToNextPendingInteractionQuestion() {
        this.#runtime.pendingInteraction.goToNextQuestion();
    }
    getNestedApprovalSnapshot() {
        return this.#runtime.nestedApproval.getSnapshot();
    }
    setNestedApprovalObserver(observer) {
        this.#nestedApprovalObserver = observer;
        this.#runtime.nestedApproval.subscribe(observer);
    }
    decideNestedApproval(requestId, decision) {
        return this.#runtime.nestedApproval.decide(requestId, decision);
    }
    /**
     * Deliver a user message into the turn already running, so the model reads it
     * mid-turn — after the tool results of the round in flight — instead of after
     * the whole turn ends. Nothing is cancelled.
     *
     * Resolves false when the running turn offers no further request boundary
     * (it is finishing, or parked on an approval); the caller then sends the
     * message as its own turn.
     */
    steerActiveTurn(input, options) {
        return this.#adapter.steerActiveTurn(input, options);
    }
    /** Deliver pre-built items into the running turn. See the adapter for terms. */
    injectIntoActiveTurn(items) {
        return this.#adapter.injectIntoActiveTurn(items);
    }
    /**
     * Returns true if a foreground turn is currently active (running,
     * completing, awaiting an approval, etc.). The orchestrator uses this to
     * decide whether to immediately append a user message to the message list
     * (when no turn is active) or display it as queued until the queue pops it.
     */
    isQueueActive() {
        return this.#adapter.isQueueActive();
    }
    /** True while a foreground queue owns the display lifecycle of new submits. */
    isQueueOwningSubmissions() {
        return this.#adapter.isQueueOwningSubmissions();
    }
    /** The queue's current state kind. Diagnostics only — do not branch on it. */
    queueStateKind() {
        return this.#adapter.queueStateKind();
    }
    #queueStateObserver = null;
    #queuedTurnStartObserver = null;
    /** Set an observer for queue state changes. The observer fires immediately with current state. */
    setQueueStateObserver(observer) {
        this.#queueStateObserver = observer;
        this.#adapter.setQueueStateObserver(observer);
    }
    /**
     * Set an observer that fires each time the queue has actually started
     * executing a queued message (after the in-flight turn finished). The
     * observer receives the internal request id and the original turn so the
     * caller can render the message in the UI at the correct timeline.
     */
    setQueuedTurnStartObserver(observer) {
        this.#queuedTurnStartObserver = observer;
        this.#adapter.setQueuedTurnStartObserver(observer);
    }
    retryLastToolOutput(options) {
        this.abort();
        const removed = this.#runtime.state.retryLastToolOutput();
        if (removed === null) {
            return Promise.resolve(null);
        }
        return this.#adapter.sendMessage('', {
            ...options,
            replayFromHistory: true,
        });
    }
    /** Regenerate the latest user turn; completed tool effects are not undone. */
    retryLastFailedTurn(options) {
        if (this.#runtime.state.listUserTurns().length === 0)
            return Promise.resolve(null);
        this.abort();
        if (!this.#runtime.state.retryLastUserTurn())
            return Promise.resolve(null);
        return this.#adapter.sendMessage('', {
            ...options,
            replayFromHistory: true,
        });
    }
    previewLargeUncachedInput(input, now) {
        return this.#runtime.state.previewLargeUncachedInput(input, now);
    }
    previewInputSurge(input) {
        return this.#runtime.state.previewInputSurge(input);
    }
    handleApprovalDecision(answer, rejectionReason, options) {
        return this.#adapter.handleApprovalDecision(answer, rejectionReason, options);
    }
    exportState() {
        return this.#runtime.state.exportState();
    }
    importState(state) {
        this.#runtime.state.importState(state);
    }
}
//# sourceMappingURL=conversation-service.js.map