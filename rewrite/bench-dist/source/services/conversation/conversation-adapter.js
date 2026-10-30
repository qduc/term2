import { injectSkillIntoTurn } from '../../types/user-turn.js';
import { collectTerminalResult, TerminalResultCollectorExhaustionError } from '../session/terminal-result-collector.js';
import { getCallIdFromObject } from '../interruption-info.js';
import { normalizeUserTurn } from '../../types/user-turn.js';
import { userTurnToProviderItem } from './user-turn-item.js';
import { getProfileLabel } from '../profiles/labels.js';
import { resolvePromptCacheKey } from '../session/session-identity.js';
import { QueueController, } from '../queue/queue-controller.js';
import { isClassifiedCancellation } from '../retry/provider-failure-classification.js';
const QUEUED_NON_TEXT_PLACEHOLDER = '[queued non-text user turn]';
const LEGACY_QUEUED_MESSAGE_PLACEHOLDER = '\u0000queued-message';
/** Upper bound for waiting on an active turn during cancel so the queue cannot stick in `cancelling`. */
const ACTIVE_CANCEL_TIMEOUT_MS = 10_000;
function queueCancellationError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}
function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
class AdmissionLeaseError extends Error {
    code;
    constructor(code) {
        super('message admission lease rejected');
        this.name = 'AdmissionLeaseError';
        this.code = code;
    }
}
export class ConversationAdapter {
    #sessionId;
    #startedAt;
    #eventSink = null;
    #awaitLogBoundary;
    #askUserAnswerSink;
    #subagentEventSinkHost;
    #logger;
    #settingsService;
    #sessionContextService;
    #userTurns;
    #logs;
    #approval;
    #pendingInteraction;
    #turnFlow;
    /** Executable payload and lifecycle; queue/mailbox entries are projections. */
    #submissions = new Map();
    #turnCompletionObservers = new Map();
    #queue;
    #nextQueuedMessageId = 1;
    #nextActionId = 1;
    #activeTurn = Promise.resolve();
    #activeRequestId = null;
    #cancellingRequestId = null;
    #cancellationEpoch = 0;
    #cancellation = Promise.resolve();
    #cancellationProven = true;
    #cancellationProof = null;
    #approvalExecutionId = null;
    #approvalActionId = null;
    #postExecuteApproval = null;
    #queueStateObserver = null;
    #beforeQueueAdvance = null;
    #queuedTurnStartObserver = null;
    #compactionAbort = null;
    #activeCancelTimeoutMs;
    #queueCapacity;
    #preparedLeaseTtlMs;
    #discardOnFailure;
    #failureDiscardedTurnIds = [];
    #preparedMessages = new Map();
    #cancelledLeases = new Set();
    #admissionClosed = false;
    #restartHeld = false;
    #currentSessionId() {
        return typeof this.#sessionId === 'string' ? this.#sessionId : this.#sessionId.current;
    }
    #currentStartedAt() {
        return typeof this.#startedAt === 'string' ? this.#startedAt : this.#startedAt.startedAt;
    }
    constructor(deps) {
        this.#sessionId = deps.sessionId;
        this.#startedAt = deps.startedAt;
        this.#askUserAnswerSink = deps.askUserAnswerSink ?? null;
        this.#subagentEventSinkHost = deps.subagentEventSinkHost ?? null;
        this.#logger = deps.logger;
        this.#awaitLogBoundary = deps.awaitLogBoundary;
        this.#settingsService = deps.settingsService;
        this.#sessionContextService = deps.sessionContextService;
        this.#userTurns = deps.userTurns;
        this.#logs = deps.logs;
        this.#approval = deps.approval;
        this.#pendingInteraction = deps.pendingInteraction ?? null;
        this.#turnFlow = deps.turnFlow;
        this.#activeCancelTimeoutMs = deps.activeCancelTimeoutMs ?? ACTIVE_CANCEL_TIMEOUT_MS;
        this.#queueCapacity = deps.queueCapacity ?? Infinity;
        this.#preparedLeaseTtlMs = deps.preparedLeaseTtlMs ?? 10_000;
        this.#discardOnFailure = deps.discardOnFailure === true;
        if (deps.queueForeground) {
            const driver = {
                start: (execution) => this.#startQueuedTurn(execution),
                cancel: async (execution) => {
                    // Prefer natural abort settlement, but report whether the bounded
                    // barrier actually proved that the active execution stopped.
                    const proof = this.#cancellationProof?.executionId === execution.executionId
                        ? this.#cancellationProof.completion
                        : this.#activeTurn;
                    const result = await Promise.race([
                        proof.then(() => true, () => true),
                        delay(this.#activeCancelTimeoutMs).then(() => false),
                    ]);
                    return result;
                },
            };
            this.#queue = new QueueController({
                driver,
                completionBarrier: () => this.#beforeQueueAdvance?.(),
                snapshotFactory: (item) => {
                    const message = this.#submissions.get(item.id);
                    return message ? { requestId: item.id } : { requestId: item.id, recovered: true };
                },
                capacity: deps.queueCapacity,
                persistence: deps.queuePersistence,
            });
        }
        else {
            this.#queue = null;
        }
    }
    /** Observe settled turns before retained input can dispatch. */
    setBeforeQueueAdvance(observer) {
        this.#beforeQueueAdvance = observer;
    }
    setEventSink(sink) {
        this.#eventSink = sink;
    }
    setQueueStateObserver(observer) {
        this.#queueStateObserver = observer;
        // Immediately notify with current state
        this.#notifyQueueState();
    }
    setQueuedTurnStartObserver(observer) {
        this.#queuedTurnStartObserver = observer;
    }
    isQueueActive() {
        if (!this.#queue) {
            // Without a queue, the adapter is a pass-through. Treat the adapter as
            // active only while the run-as-foreground path is in flight.
            return false;
        }
        const state = this.#queue.state();
        return (state.kind === 'running' ||
            state.kind === 'awaiting_active_action' ||
            state.kind === 'cancelling' ||
            state.kind === 'completing');
    }
    /** Whether the foreground queue owns a new submission's UI lifecycle. */
    isQueueOwningSubmissions() {
        if (!this.#queue)
            return false;
        if (this.#queue.isDispatchHeld())
            return true;
        const state = this.#queue.state();
        return state.kind !== 'idle' || state.queue.length > 0;
    }
    /**
     * Occupy the foreground queue the way an in-flight turn does, so new
     * submits enqueue instead of starting. False when a turn already owns it.
     */
    holdForegroundQueue(options = {}) {
        if (!this.#queue)
            return true;
        const held = this.#queue.holdDispatch(options);
        if (held)
            this.#notifyQueueState();
        return held;
    }
    /** Reserve only a restart handoff. On refusal nothing is discarded; release restores normal admission. */
    async prepareRestart() {
        if (this.#restartHeld)
            throw new Error('Restart is already being prepared.');
        if (!this.#queue || !this.#queue.holdDispatch({ allowPaused: true })) {
            throw new Error('Finish or stop the current foreground operation, then run /restart.');
        }
        this.#restartHeld = true;
        let released = false;
        const release = () => {
            if (released)
                return;
            released = true;
            this.#restartHeld = false;
            this.#queue.releaseDispatch();
        };
        try {
            if ([...this.#preparedMessages.values()].some((item) => item.expiresAt > Date.now()) ||
                [...this.#submissions.values()].some((item) => item.stage === 'pending_steer')) {
                throw new Error('Unsettled input is still being admitted; finish or cancel it before restarting.');
            }
            await this.#queue.assertRestartDurable();
            const volatile = this.#queue.state().queue.filter((item) => {
                const submission = this.#submissions.get(item.id);
                if (!submission)
                    return item.text === QUEUED_NON_TEXT_PLACEHOLDER || item.text === LEGACY_QUEUED_MESSAGE_PLACEHOLDER;
                const turn = normalizeUserTurn(submission.input);
                return Boolean(turn.images?.length ||
                    turn.skill ||
                    submission.options.replayFromHistory ||
                    submission.options.suppressUserMessageDisplay ||
                    turn.text !== item.text);
            });
            if (volatile.length) {
                throw new Error(`Pending input ${volatile
                    .map((item) => item.id)
                    .join(', ')} contains images, a skill, or other non-durable input. Run, edit, or explicitly discard it before /restart.`);
            }
            return release;
        }
        catch (error) {
            release();
            throw error;
        }
    }
    releaseForegroundQueue(options = {}) {
        this.#queue?.releaseDispatch(options);
        this.#notifyQueueState();
    }
    attachCompactionAbort(controller) {
        this.#compactionAbort = controller;
    }
    detachCompactionAbort(controller) {
        if (this.#compactionAbort === controller)
            this.#compactionAbort = null;
    }
    /**
     * The queue's current state kind, for diagnostics only.
     *
     * `isQueueOwningSubmissions` and `isQueueActive` disagree on several states —
     * a submission can be owned by the queue (so the UI shows it as queued) while
     * the queue is not active (so a steer is refused before it is ever offered to
     * the turn). This names the state so that gap is visible in the logs.
     */
    queueStateKind() {
        return this.#queue ? this.#queue.state().kind : 'none';
    }
    queuedSubmissionCount() {
        return this.#queue?.state().queue.length ?? 0;
    }
    #notifyQueueState() {
        if (!this.#queue || !this.#queueStateObserver)
            return;
        const state = this.#queue.state();
        this.#queueStateObserver({
            queueLength: state.queue.length,
            stateKind: state.kind,
            pauseReason: 'reason' in state ? state.reason : undefined,
        });
    }
    #getTrafficMode() {
        if (!this.#settingsService)
            return 'standard';
        return getProfileLabel(String(this.#settingsService.get('app.activeProfileId')));
    }
    #withTrafficContext(currentTurn, fn) {
        const mode = this.#getTrafficMode();
        const turns = this.#userTurns.listUserTurns();
        const firstTurn = turns[0]?.text ?? currentTurn;
        const firstUserMessagePreview = firstTurn ? firstTurn.slice(0, 160).replace(/\n/g, ' ') : undefined;
        return this.#sessionContextService.runWithContext({
            sessionId: this.#currentSessionId(),
            sessionStartedAt: this.#currentStartedAt(),
            promptCacheKey: resolvePromptCacheKey(this.#sessionId),
            mode,
            traceId: this.#logger.getCorrelationId(),
            firstUserMessagePreview,
        }, fn);
    }
    /** Compatibility view of mailbox admission; submitMessage also owns fallback. */
    async steerActiveTurn(input, options) {
        const turn = normalizeUserTurn(input);
        if (!turn.text.trim() && !turn.images?.length)
            return false;
        const id = options?.id;
        // Addressed legacy callers share the registry; normal submissions already
        // own their record before asking the mailbox to admit its projection.
        const record = id && !this.#submissions.has(id)
            ? { stage: 'pending_steer', input: turn, options: {}, resolve: () => undefined, reject: () => undefined }
            : undefined;
        if (id && record)
            this.#submissions.set(id, record);
        try {
            return await this.injectIntoActiveTurn([userTurnToProviderItem(turn, { steering: true })], options);
        }
        finally {
            if (id && record && this.#submissions.get(id) === record)
                this.#submissions.delete(id);
        }
    }
    /**
     * Hand pre-built items to the turn already running, admitted at its next
     * request boundary.
     *
     * Steering is the user's case of this; a settled background subagent run and
     * shell-session context are the same act by a different speaker, so they
     * share the delivery and differ only in the text they carry. Resolves false
     * when no turn will take them, leaving the caller to deliver them itself.
     *
     * Keeps its boolean signature regardless of caller: the run loop's
     * `SteerOutcome` union is collapsed here to `'admitted' → true`, everything
     * else `→ false`. Only `retractSubmission`/`editSubmission` need the richer
     * outcome, and they get it by calling `retractSteer`/`editSteer` directly.
     */
    async injectIntoActiveTurn(items, options) {
        if (!this.#turnFlow.steer || items.length === 0)
            return false;
        if (!this.isQueueActive())
            return false;
        const id = options?.id;
        const outcome = await this.#turnFlow.steer(items, id ? { id } : undefined);
        return outcome === 'admitted';
    }
    /** Mutate only the owner's still-pending record and its queue/mailbox projection. */
    async retractSubmission(id) {
        if (this.#restartHeld)
            throw new Error('Restart is being prepared; pending input was not changed.');
        if (this.#submissions.get(id)?.stage === 'pending_steer') {
            if (!this.#turnFlow.retractSteer) {
                throw new Error(`ConversationAdapter.retractSubmission: pending steer '${id}' has no turnFlow.retractSteer to route to`);
            }
            const retracted = this.#turnFlow.retractSteer(id);
            if (!retracted)
                return { kind: 'too_late', stage: 'started' };
            this.#submissions.delete(id);
            return { kind: 'applied', stage: 'pending_steer' };
        }
        if (this.#queue) {
            const inQueue = this.#queue.state().queue.some((item) => item.id === id);
            if (inQueue) {
                const result = await this.#queue.command({ kind: 'remove_queued', itemId: id });
                if (result.kind !== 'accepted')
                    return { kind: 'too_late', stage: 'started' };
                this.#settleFailure(id, queueCancellationError('Queued message was removed'));
                this.#notifyQueueState();
                return { kind: 'applied', stage: 'queued' };
            }
        }
        if (this.#submissions.has(id))
            return { kind: 'too_late', stage: 'started' };
        return { kind: 'unknown_id' };
    }
    /** Keep the executable payload and display projection in the same mutation. */
    async editSubmission(id, turn) {
        if (this.#restartHeld)
            throw new Error('Restart is being prepared; pending input was not changed.');
        if (this.#submissions.get(id)?.stage === 'pending_steer') {
            if (!this.#turnFlow.editSteer) {
                throw new Error(`ConversationAdapter.editSubmission: pending steer '${id}' has no turnFlow.editSteer to route to`);
            }
            const submission = this.#submissions.get(id);
            const item = userTurnToProviderItem(normalizeUserTurn(submission.prepareInput?.(turn) ?? turn), {
                steering: true,
            });
            const edited = this.#turnFlow.editSteer(id, [item]);
            if (!edited)
                return { kind: 'too_late', stage: 'started' };
            submission.input = structuredClone(turn);
            const { inputSurgeApproval: _approval, ...options } = submission.options;
            submission.options = options;
            return { kind: 'applied', stage: 'pending_steer' };
        }
        if (this.#queue) {
            const inQueue = this.#queue.state().queue.some((item) => item.id === id);
            if (inQueue) {
                const message = this.#submissions.get(id);
                if (!message)
                    return { kind: 'unknown_id' };
                const { inputSurgeApproval: _invalidatedApproval, ...options } = message.options;
                this.#submissions.set(id, { ...message, input: structuredClone(turn), options });
                const displayText = normalizeUserTurn(turn).text;
                const controllerText = displayText.trim() ? displayText : QUEUED_NON_TEXT_PLACEHOLDER;
                const result = await this.#queue.command({ kind: 'edit_queued', itemId: id, text: controllerText });
                if (result.kind !== 'accepted') {
                    if (this.#submissions.has(id)) {
                        this.#submissions.set(id, message);
                    }
                    return { kind: 'too_late', stage: 'started' };
                }
                this.#notifyQueueState();
                return { kind: 'applied', stage: 'queued' };
            }
        }
        if (this.#submissions.has(id))
            return { kind: 'too_late', stage: 'started' };
        return { kind: 'unknown_id' };
    }
    /**
     * Own steer admission and fallback with the same id and latest payload.
     * An admitted steer returns immediately; completion observes only the turn
     * it joined (null on failure/cancellation), never a later queued response.
     */
    async submitMessage(input, options = {}, delivery) {
        if (this.#restartHeld)
            throw new Error('Restart is being prepared; this message was not admitted.');
        const id = options.preferredMessageId ?? String(this.#nextQueuedMessageId++);
        if (this.#submissions.has(id))
            throw new Error(`A submission already uses request id ${id}`);
        const submission = {
            stage: 'pending_steer',
            prepareInput: (value) => (typeof value === 'string' ? value : injectSkillIntoTurn(value)),
            input: structuredClone(input),
            options,
            resolve: () => undefined,
            reject: () => undefined,
        };
        if (options.busyMode !== 'steer' || !this.isQueueOwningSubmissions()) {
            return {
                kind: 'turn',
                terminal: await this.#sendMessage(submission.input, {
                    ...options,
                    preferredMessageId: id,
                }, submission),
            };
        }
        this.#submissions.set(id, submission);
        const epoch = this.#cancellationEpoch;
        // Capture ownership before awaiting mailbox admission: settlement can race
        // the admission continuation, and a later queued turn is not our result.
        const owner = this.#activeRequestId;
        let complete;
        const completion = new Promise((resolve) => {
            complete = resolve;
        });
        if (owner) {
            const observers = this.#turnCompletionObservers.get(owner) ?? new Set();
            observers.add(complete);
            this.#turnCompletionObservers.set(owner, observers);
        }
        let joined = false;
        try {
            const admitted = await this.steerActiveTurn(submission.prepareInput(submission.input), { id });
            if ((!admitted && epoch !== this.#cancellationEpoch) || this.#submissions.get(id) !== submission) {
                throw queueCancellationError('Pending submission was cancelled');
            }
            delivery?.onSteerSettled(admitted, submission.input);
            if (admitted) {
                joined = true;
                this.#submissions.delete(id);
                return { kind: 'steered', completion: owner ? completion : Promise.resolve(null) };
            }
            submission.input = delivery?.prepareFollowUp?.(submission.input) ?? submission.input;
            return {
                kind: 'turn',
                terminal: await this.#sendMessage(submission.input, {
                    ...submission.options,
                    preferredMessageId: id,
                }, submission),
            };
        }
        finally {
            if (!joined && owner) {
                const observers = this.#turnCompletionObservers.get(owner);
                observers?.delete(complete);
                if (observers?.size === 0)
                    this.#turnCompletionObservers.delete(owner);
            }
            if (this.#submissions.get(id) === submission && submission.stage === 'pending_steer') {
                this.#submissions.delete(id);
            }
        }
    }
    sendMessage(input, options = {}) {
        return this.#sendMessage(input, options);
    }
    async #sendMessage(input, { onAdmission, onTextChunk, onReasoningChunk, onCommandMessage, onEvent, hallucinationRetryCount = 0, inputSurgeApproval, replayFromHistory, preferredMessageId, busyMode, rolloverBrief, suppressUserMessageDisplay, } = {}, existing) {
        if (this.#restartHeld)
            throw new Error('Restart is being prepared; this message was not admitted.');
        const queue = this.#queue;
        if (!queue) {
            return this.#executeMessage(existing?.prepareInput?.(input) ?? input, {
                onTextChunk,
                onReasoningChunk,
                onCommandMessage,
                onEvent,
                hallucinationRetryCount,
                inputSurgeApproval,
                replayFromHistory,
                suppressUserMessageDisplay,
            }).then(async (result) => {
                await this.#recordPendingInteraction(result);
                return result;
            });
        }
        return new Promise((resolve, reject) => {
            const requestId = preferredMessageId ?? String(this.#nextQueuedMessageId++);
            if (this.#submissions.has(requestId) && this.#submissions.get(requestId) !== existing) {
                reject(new Error(`A queued message already uses request id ${requestId}`));
                return;
            }
            const message = {
                stage: 'queued',
                prepareInput: existing?.prepareInput,
                input: typeof input === 'string' ? input : structuredClone(input),
                options: {
                    onTextChunk,
                    onReasoningChunk,
                    onCommandMessage,
                    onEvent,
                    hallucinationRetryCount,
                    inputSurgeApproval,
                    replayFromHistory,
                    suppressUserMessageDisplay,
                    busyMode,
                },
                resolve,
                reject,
            };
            if (existing)
                Object.assign(existing, message);
            this.#submissions.set(requestId, existing ?? message);
            const displayText = normalizeUserTurn(input).text;
            const controllerText = displayText.trim() ? displayText : QUEUED_NON_TEXT_PLACEHOLDER;
            void queue
                .command({
                kind: rolloverBrief ? 'submit_held' : busyMode === 'steer' ? 'steer' : 'submit',
                id: requestId,
                text: controllerText,
            })
                .then(async (result) => {
                if (result.kind !== 'accepted') {
                    const reason = result.kind === 'rejected' ? result.reason : result.kind;
                    const error = new Error(`Foreground queue rejected message: ${reason}`);
                    onAdmission?.(error);
                    await this.#eventSink?.({ type: 'error', message: error.message, kind: 'admission_rejected' });
                    this.#settleFailure(requestId, error);
                }
                else {
                    onAdmission?.();
                }
                this.#notifyQueueState();
            })
                .catch((error) => {
                onAdmission?.(error);
                this.#settleFailure(requestId, error);
                this.#notifyQueueState();
            });
        });
    }
    async prepareMessage(input, ids) {
        const now = Date.now();
        for (const [leaseId, prepared] of this.#preparedMessages) {
            if (prepared.expiresAt <= now)
                this.#preparedMessages.delete(leaseId);
        }
        if (this.#admissionClosed || this.#restartHeld)
            return { kind: 'rejected', reason: 'closed' };
        if (!ids.turnId ||
            !ids.clientRequestId ||
            [...this.#preparedMessages.values()].some((prepared) => prepared.turnId === ids.turnId || prepared.clientRequestId === ids.clientRequestId)) {
            return { kind: 'rejected', reason: 'busy' };
        }
        const state = this.#queue?.state();
        if (!this.#queue && this.isQueueActive())
            return { kind: 'rejected', reason: 'busy' };
        if (state && state.queue.length + this.#preparedMessages.size >= this.#queueCapacity) {
            return { kind: 'rejected', reason: 'queue_full' };
        }
        const leaseId = crypto.randomUUID();
        this.#preparedMessages.set(leaseId, {
            input: typeof input === 'string' ? input : structuredClone(input),
            turnId: ids.turnId,
            clientRequestId: ids.clientRequestId,
            expiresAt: Date.now() + this.#preparedLeaseTtlMs,
        });
        return { kind: 'prepared', leaseId, turnId: ids.turnId };
    }
    async commitMessage(leaseId) {
        if (this.#admissionClosed || this.#restartHeld)
            throw new AdmissionLeaseError('closed');
        const prepared = this.#preparedMessages.get(leaseId);
        if (!prepared)
            throw new AdmissionLeaseError('stale');
        if (prepared.expiresAt <= Date.now()) {
            this.#preparedMessages.delete(leaseId);
            throw new AdmissionLeaseError('stale');
        }
        this.#preparedMessages.delete(leaseId);
        await new Promise((resolve, reject) => {
            const terminal = this.sendMessage(prepared.input, {
                preferredMessageId: prepared.turnId,
                onAdmission: (error) => (error ? reject(error) : resolve()),
            });
            // The admission callback reports queue rejection; this handler prevents
            // the later terminal rejection from becoming an unhandled promise.
            terminal.then(() => undefined, () => undefined);
        });
    }
    async cancelPreparedMessage(leaseId) {
        if (this.#admissionClosed || this.#restartHeld)
            throw new AdmissionLeaseError('closed');
        if (this.#cancelledLeases.has(leaseId))
            return;
        const prepared = this.#preparedMessages.get(leaseId);
        if (!prepared)
            throw new AdmissionLeaseError('stale');
        this.#preparedMessages.delete(leaseId);
        if (prepared.expiresAt <= Date.now())
            throw new AdmissionLeaseError('stale');
        this.#cancelledLeases.add(leaseId);
    }
    async abortAndDiscard() {
        const discarded = [...this.#preparedMessages.values()].map((item) => item.turnId);
        this.#preparedMessages.clear();
        this.abort();
        await this.#cancellation;
        if (this.#queue) {
            discarded.push(...this.#queue.state().queue.map((item) => item.id));
            await this.discardQueue();
        }
        return { discardedTurnIds: [...new Set(discarded)], proven: this.#cancellationProven };
    }
    closeAdmission() {
        this.#admissionClosed = true;
        const discarded = [...this.#preparedMessages.values()].map((item) => item.turnId);
        this.#preparedMessages.clear();
        return discarded;
    }
    reopenAdmission() {
        if (this.#cancellationProven)
            this.#admissionClosed = false;
    }
    preparedMessageCount() {
        return this.#preparedMessages.size;
    }
    consumeFailureDiscardedTurnIds() {
        const discarded = [...new Set(this.#failureDiscardedTurnIds)];
        this.#failureDiscardedTurnIds.length = 0;
        return discarded;
    }
    async resumeQueue() {
        if (!this.#queue)
            return;
        await this.#cancellation;
        await this.#queue.command({ kind: 'resume_queue' });
        this.#notifyQueueState();
    }
    async discardQueue() {
        if (!this.#queue)
            return;
        const queuedIds = this.#queue.state().queue.map((item) => item.id);
        const result = await this.#queue.command({ kind: 'discard_queue' });
        if (result.kind === 'accepted') {
            for (const requestId of queuedIds) {
                this.#settleFailure(requestId, queueCancellationError('Queued message was discarded'));
            }
        }
        this.#notifyQueueState();
    }
    abort() {
        this.#compactionAbort?.abort();
        this.#cancellationEpoch++;
        this.#pendingInteraction?.clear();
        if (!this.#queue) {
            this.#turnFlow.abort?.();
            return;
        }
        // Abort the live model/tool turn, then ask the controller to leave running
        // and pause with retained work. If the active turn fails to settle on its
        // own (a hung generator, missing abort hook, etc.), force-settle the active
        // request so orchestrator awaits cannot stick forever. Retained queued
        // requests stay pending — pause is not a terminal fate.
        const queueState = this.#queue.state();
        if (queueState.kind === 'cancelling')
            return;
        const activeRequestId = this.#activeRequestId;
        const activeExecutionId = queueState.kind === 'running' || queueState.kind === 'awaiting_active_action'
            ? queueState.active.executionId
            : null;
        this.#cancellingRequestId = activeRequestId;
        const abortCompletion = Promise.resolve(this.#turnFlow.abort?.());
        const proof = activeExecutionId ? { executionId: activeExecutionId, completion: abortCompletion } : null;
        this.#cancellationProof = proof;
        this.#cancellationProven = true;
        this.#cancellation = this.#queue.command({ kind: 'cancel' }).then((result) => {
            this.#cancellationProven = result.kind !== 'rejected' || result.reason !== 'cancellation_unproven';
            if (!this.#cancellationProven && proof) {
                const settle = () => {
                    void this.#queue?.command({ kind: 'cancellation_settled', executionId: proof.executionId }).then(() => {
                        if (this.#cancellationProof === proof)
                            this.#cancellationProof = null;
                        this.#notifyQueueState();
                    }, (error) => {
                        this.#logger.error('Failed to settle an unproven queue cancellation', {
                            error: error instanceof Error ? error.message : String(error),
                            executionId: proof.executionId,
                        });
                    });
                };
                void proof.completion.then(settle, settle);
            }
            if (this.#cancellationProven && activeRequestId && this.#submissions.has(activeRequestId)) {
                this.#settleFailure(activeRequestId, queueCancellationError('Active turn was cancelled'));
            }
            if (this.#cancellationProven && this.#activeRequestId === activeRequestId) {
                this.#activeRequestId = null;
            }
            if (this.#cancellationProven && this.#cancellingRequestId === activeRequestId) {
                this.#cancellingRequestId = null;
            }
            if (this.#cancellationProven && this.#cancellationProof === proof)
                this.#cancellationProof = null;
            this.#notifyQueueState();
        });
    }
    #startQueuedTurn(execution) {
        // Notify the orchestrator/UI before kicking off the run so that the user
        // message can be appended to the message list with the correct timeline.
        // Recovered items have no #submissions entry; still fire so a delivered
        // row cannot stay in the pending list after the queue has started it.
        const message = this.#submissions.get(execution.snapshot.requestId);
        if (message)
            message.stage = 'started';
        if (this.#queuedTurnStartObserver) {
            try {
                this.#queuedTurnStartObserver({
                    requestId: execution.snapshot.requestId,
                    input: message?.input ?? execution.item.text,
                    suppressUserMessageDisplay: message?.options.suppressUserMessageDisplay,
                });
            }
            catch (error) {
                this.#logger.error('queuedTurnStartObserver threw', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        this.#activeRequestId = execution.snapshot.requestId;
        this.#activeTurn = this.#runQueuedTurn(execution).finally(() => {
            if (this.#activeRequestId === execution.snapshot.requestId) {
                this.#activeRequestId = null;
            }
        });
    }
    /**
     * Run one foreground queue item.
     *
     * Failure policy: a failed active turn emits `failed` to the controller, which
     * pauses the queue (`reason: 'failure'`) whenever retained work remains. The
     * next item does not auto-start; the user must resume or discard. Cancellation
     * of the active turn is the same shape with `reason: 'manual'`.
     */
    async #runQueuedTurn(execution) {
        const message = this.#submissions.get(execution.snapshot.requestId);
        try {
            const recoveredInput = execution.item.text === QUEUED_NON_TEXT_PLACEHOLDER || execution.item.text === LEGACY_QUEUED_MESSAGE_PLACEHOLDER
                ? null
                : execution.item.text;
            if (!message && !recoveredInput) {
                throw new Error('Recovered queued message has no executable text input');
            }
            const result = await this.#executeMessage(message ? message.prepareInput?.(message.input) ?? message.input : recoveredInput, message?.options ?? {}, execution.snapshot.requestId);
            if (result.type === 'approval_required') {
                this.#approvalExecutionId = execution.executionId;
                this.#approvalActionId = `adapter-action-${this.#nextActionId++}`;
                await this.#queue.event({
                    kind: 'tool_approval_requested',
                    executionId: execution.executionId,
                    actionId: this.#approvalActionId,
                    request: {}, // existing runtime doesn't expose typed tool request details
                });
                this.#notifyQueueState();
                await this.#recordPendingInteraction(result);
                this.#settleSuccess(execution.snapshot.requestId, result);
                return;
            }
            await this.#queue.event({ kind: 'completed', executionId: execution.executionId, terminal: result });
            this.#notifyQueueState();
            await this.#recordPendingInteraction(result);
            this.#settleSuccess(execution.snapshot.requestId, result);
        }
        catch (error) {
            const failure = this.#cancellingRequestId === execution.snapshot.requestId &&
                error instanceof TerminalResultCollectorExhaustionError
                ? queueCancellationError('Active turn was cancelled')
                : error;
            // Controller pauses with retained queue on failure when work remains.
            try {
                await this.#queue.event({ kind: 'failed', executionId: execution.executionId, failure });
                if (this.#discardOnFailure) {
                    this.#failureDiscardedTurnIds.push(...this.#queue.state().queue.map((item) => item.id));
                    await this.discardQueue();
                }
                this.#notifyQueueState();
            }
            catch (queueError) {
                this.#logger.error('Failed to settle queued turn failure state', {
                    error: queueError instanceof Error ? queueError.message : String(queueError),
                });
            }
            if (!isClassifiedCancellation(failure)) {
                try {
                    await this.#eventSink?.({
                        type: 'error',
                        message: failure instanceof Error ? failure.message : String(failure),
                        kind: 'turn_failed',
                    });
                }
                catch (eventError) {
                    // The failure event is itself critical at the gateway boundary. It
                    // must not prevent the owning submission from settling or leave
                    // #activeTurn as an unhandled rejection.
                    this.#logger.error('Failed to publish queued turn failure event', {
                        error: eventError instanceof Error ? eventError.message : String(eventError),
                    });
                }
            }
            this.#settleFailure(execution.snapshot.requestId, failure);
        }
    }
    #notifyTurnCompletion(requestId, terminal) {
        const observers = this.#turnCompletionObservers.get(requestId);
        this.#turnCompletionObservers.delete(requestId);
        for (const observer of observers ?? [])
            observer(terminal);
    }
    #settleSuccess(requestId, terminal) {
        this.#notifyTurnCompletion(requestId, terminal);
        const message = this.#submissions.get(requestId);
        if (!message)
            return;
        this.#submissions.delete(requestId);
        message.resolve(terminal);
    }
    #settleFailure(requestId, error) {
        this.#notifyTurnCompletion(requestId, null);
        const message = this.#submissions.get(requestId);
        if (!message)
            return;
        this.#submissions.delete(requestId);
        message.reject(error);
    }
    async #collectTerminalResult(events, options, cancellationEpoch, requestId) {
        try {
            return await collectTerminalResult(events, options);
        }
        catch (error) {
            const wasCancelled = error instanceof TerminalResultCollectorExhaustionError &&
                (cancellationEpoch < this.#cancellationEpoch ||
                    (Boolean(requestId) && this.#cancellingRequestId === requestId));
            if (wasCancelled) {
                throw queueCancellationError('Active turn was cancelled');
            }
            throw error;
        }
    }
    async #executeMessage(input, { onTextChunk, onReasoningChunk, onCommandMessage, onEvent, hallucinationRetryCount = 0, inputSurgeApproval, replayFromHistory, suppressUserMessageDisplay, } = {}, requestId) {
        const turn = normalizeUserTurn(input);
        const cancellationEpoch = this.#cancellationEpoch;
        return this.#withTrafficContext(turn.text, async () => {
            const wrappedOnEvent = async (event) => {
                if (event.type === 'approval_required') {
                    // Install the authoritative session snapshot before any gateway/UI
                    // sink sees the approval event. The runtime retains the private
                    // interruption in SessionApprovalQuery; this public event carries
                    // only its already-sanitized descriptor shape.
                    this.#pendingInteraction?.present({
                        ...event.approval,
                        rawInterruption: null,
                    });
                }
                if (this.#awaitLogBoundary) {
                    this.#logs.dispatchEventToLog(event);
                    await this.#awaitLogBoundary(event);
                    await this.#eventSink?.(event);
                }
                else {
                    await this.#eventSink?.(event);
                    this.#logs.dispatchEventToLog(event);
                }
                await onEvent?.(event);
            };
            let result;
            try {
                await this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
                const startOptions = { retries: { hallucinationRetryCount } };
                if (inputSurgeApproval !== undefined) {
                    startOptions.inputSurgeApproval = inputSurgeApproval;
                }
                if (replayFromHistory) {
                    startOptions.replayFromHistory = true;
                }
                if (suppressUserMessageDisplay)
                    startOptions.modelOnlyInput = true;
                result = await this.#collectTerminalResult(this.#turnFlow.start(input, startOptions), {
                    onTextChunk,
                    onReasoningChunk,
                    onCommandMessage,
                    onEvent: wrappedOnEvent,
                    getRawInterruption: () => this.#approval.getPendingInterruption(),
                    onFinalEvent: (event) => {
                        this.#logger.debug('sendMessage received final event', {
                            sessionId: this.#currentSessionId(),
                            hasUsage: Boolean(event.usage),
                            usage: event.usage,
                        });
                    },
                }, cancellationEpoch, requestId);
            }
            finally {
                this.#subagentEventSinkHost?.cancelSubagentRuns?.();
                await this.#subagentEventSinkHost?.setSubagentEventSink(null);
            }
            if (result.type === 'response') {
                this.#logger.debug('sendMessage returning response', {
                    sessionId: this.#currentSessionId(),
                    hasUsage: Boolean(result.usage),
                    usage: result.usage,
                });
            }
            this.#postExecuteApproval = result.type === 'approval_required' ? result.approval.postExecute ?? null : null;
            return result;
        });
    }
    async handleApprovalDecision(answer, rejectionReason, { onTextChunk, onReasoningChunk, onCommandMessage, onEvent, approvalAnswer, stopAfterApprovalResolution, } = {}) {
        const postExecuteApproval = this.#postExecuteApproval;
        const pendingApproval = this.#approval.getPending();
        if (!pendingApproval && !postExecuteApproval) {
            return null;
        }
        if (postExecuteApproval) {
            const snapshot = this.#approval.getPostExecutePending();
            if (snapshot.sessionId !== postExecuteApproval.sessionId || snapshot.epoch !== postExecuteApproval.epoch) {
                return null;
            }
            const decision = this.#approval.decidePostExecutePending({
                revision: postExecuteApproval.revision,
                ids: postExecuteApproval.ids,
                decision: answer === 'y'
                    ? 'approve'
                    : answer === 'allow-once' || answer === 'allow-remember' || answer === 'unsandboxed-once'
                        ? answer
                        : 'reject',
            });
            if (decision.kind !== 'settled')
                return null;
            this.#postExecuteApproval = null;
        }
        if (answer === 'y' && approvalAnswer) {
            const callId = pendingApproval ? getCallIdFromObject(pendingApproval.interruption) : undefined;
            if (callId) {
                this.#askUserAnswerSink?.setAskUserAnswer(callId, approvalAnswer);
            }
        }
        // This facade is also used directly by non-interactive callers. Clear the
        // session projection here as well as through the interactive semantic
        // resolver, so the continuation API remains self-contained.
        this.#pendingInteraction?.clear();
        this.#logs.log({
            type: 'approval_resolved',
            answer: answer === 'y' ? 'y' : 'n',
            ...(rejectionReason ? { rejectionReason } : {}),
        });
        // Capture before resolving the queue action: persistence may await while
        // an abort invalidates this approval and makes the coordinator idle.
        const cancellationEpoch = this.#cancellationEpoch;
        try {
            // If queue tracks this approval, resolve the typed action before continuing.
            if (this.#queue && this.#approvalExecutionId && this.#approvalActionId) {
                const actionCmd = await this.#queue.command({
                    kind: 'resolve_tool_approval',
                    executionId: this.#approvalExecutionId,
                    actionId: this.#approvalActionId,
                    approved: answer === 'y',
                });
                this.#notifyQueueState();
                // If the queue rejected (e.g. stale from concurrent cancel), proceed
                // with the direct continuation but do not attempt further queue events.
                if (actionCmd.kind !== 'accepted') {
                    this.#approvalExecutionId = null;
                    this.#approvalActionId = null;
                }
            }
            if (cancellationEpoch < this.#cancellationEpoch) {
                throw queueCancellationError('Approval decision was cancelled');
            }
            // Queue resolution may await persistence while abort/new-turn work replaces
            // the pending approval. A decision captured for the old approval must not
            // adopt whichever approval happens to be current when continuation starts.
            if (!postExecuteApproval) {
                const currentApproval = this.#approval.getPending();
                const sameApproval = pendingApproval?.token !== undefined
                    ? currentApproval?.token === pendingApproval.token
                    : currentApproval === pendingApproval;
                if (!sameApproval)
                    return null;
            }
            const result = await this.#withTrafficContext(undefined, async () => {
                const wrappedOnEvent = async (event) => {
                    if (event.type === 'approval_required') {
                        // Install the authoritative session snapshot before any gateway/UI
                        // sink sees the approval event. The runtime retains the private
                        // interruption in SessionApprovalQuery; this public event carries
                        // only its already-sanitized descriptor shape.
                        this.#pendingInteraction?.present({
                            ...event.approval,
                            rawInterruption: null,
                        });
                    }
                    if (this.#awaitLogBoundary) {
                        this.#logs.dispatchEventToLog(event);
                        await this.#awaitLogBoundary(event);
                        await this.#eventSink?.(event);
                    }
                    else {
                        await this.#eventSink?.(event);
                        this.#logs.dispatchEventToLog(event);
                    }
                    await onEvent?.(event);
                };
                let result;
                try {
                    await this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
                    result = await this.#collectTerminalResult(postExecuteApproval
                        ? this.#turnFlow.continueAfterPostExecuteApproval()
                        : this.#turnFlow.continueAfterApproval({
                            answer,
                            rejectionReason,
                            ...(stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
                        }), {
                        onTextChunk,
                        onReasoningChunk,
                        onCommandMessage,
                        onEvent: wrappedOnEvent,
                        getRawInterruption: () => this.#approval.getPendingInterruption(),
                        onFinalEvent: (event) => {
                            this.#logger.debug('handleApprovalDecision received final event', {
                                sessionId: this.#currentSessionId(),
                                hasUsage: Boolean(event.usage),
                                usage: event.usage,
                            });
                        },
                    }, cancellationEpoch, this.#activeRequestId);
                }
                finally {
                    this.#subagentEventSinkHost?.cancelSubagentRuns?.();
                    await this.#subagentEventSinkHost?.setSubagentEventSink(null);
                }
                if (result && result.type === 'response') {
                    this.#logger.debug('handleApprovalDecision returning response', {
                        sessionId: this.#currentSessionId(),
                        hasUsage: Boolean(result.usage),
                        usage: result.usage,
                    });
                }
                return result;
            });
            this.#postExecuteApproval = result?.type === 'approval_required' ? result.approval.postExecute ?? null : null;
            if (result && this.#queue && this.#approvalExecutionId) {
                const executionId = this.#approvalExecutionId;
                if (result.type === 'approval_required') {
                    // A continuation may request another tool approval. Keep the same
                    // queue execution active and replace its resolved action rather than
                    // retiring it and dispatching the next message while the turn is
                    // still awaiting approval.
                    this.#approvalActionId = `adapter-action-${this.#nextActionId++}`;
                    await this.#queue.event({
                        kind: 'tool_approval_requested',
                        executionId,
                        actionId: this.#approvalActionId,
                        request: {},
                    });
                    this.#notifyQueueState();
                }
                else {
                    this.#approvalExecutionId = null;
                    this.#approvalActionId = null;
                    await this.#queue.event({ kind: 'completed', executionId, terminal: result });
                    this.#notifyQueueState();
                }
            }
            if (result)
                await this.#recordPendingInteraction(result);
            return result;
        }
        catch (error) {
            if (this.#queue && this.#approvalExecutionId) {
                const executionId = this.#approvalExecutionId;
                this.#approvalExecutionId = null;
                this.#approvalActionId = null;
                await this.#queue.event({ kind: 'failed', executionId, failure: error });
                this.#notifyQueueState();
            }
            throw error;
        }
    }
    async #recordPendingInteraction(result) {
        if (result.type === 'approval_required') {
            // The event bridge presents before publication. Keep a fallback for
            // terminal/test paths that return an approval without emitting its event,
            // but never replace an already-live snapshot (which would change its
            // optimistic-concurrency ID).
            if (!this.#pendingInteraction?.getSnapshot?.()) {
                const safeApproval = { ...result.approval, rawInterruption: null };
                this.#pendingInteraction?.present(safeApproval);
                const approvalEvent = { type: 'approval_required', approval: safeApproval };
                await this.#eventSink?.(approvalEvent);
            }
        }
        else {
            this.#pendingInteraction?.clear();
        }
    }
}
//# sourceMappingURL=conversation-adapter.js.map