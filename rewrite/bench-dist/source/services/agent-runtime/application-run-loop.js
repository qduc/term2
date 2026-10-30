import { waitForAbortableRead } from '../../contracts/abort-aware-wait.js';
import { isOpenAICompaction, projectModelRequestHistory } from '../conversation/conversation-state-projector.js';
import { getCatalogModel } from '../../providers/model-catalog/catalog.js';
import { resolveRequestOutput } from './model-context-policy.js';
import { z } from 'zod';
import { enforceRequestInputLimit, RequestInputLimitError, ProviderContextOverflowError, isProviderContextOverflow, } from './request-input-limit.js';
import { createContinuationHandle, unwrapContinuationHandle, } from '../../contracts/continuation-handle.js';
import { createAgentStream } from '../agent-stream.js';
import { ASSISTANT_TEXT_PART_SEPARATOR } from '../../contracts/streamed-model-turn.js';
import { getRunCodeExecutionResult, runCodeExecutionMetadata } from '../../tools/system/run-code/run-code-execution.js';
import { isZodToolParameterSchema } from '../../tools/types.js';
import { describeError } from '../../utils/error-helpers.js';
import { ApprovalLedger } from './tool-invocation-context.js';
import { RunBudget, isRunBudgetInteraction, } from './run-budget.js';
import { addTokenUsage, normalizeUsage } from '../../utils/ai/token-usage.js';
import { extractAiSdkUpstreamProvider } from '../../providers/ai-sdk-streamed-model.js';
import { computeModelCost } from '../../services/cost/model-cost.js';
import { getCatalogPricingVersion, getModelPricing } from '../../services/cost/pricing.js';
import { DEFAULT_TOOL_ARGUMENT_RUNAWAY_SIGNATURE, GenerationGuard, GenerationGuardError, GenerationStreamDeadlines, ToolArgumentRunawayGuard, } from './generation-guard.js';
import { classifyInLoopModelRetry, sleepWithAbort } from '../retry/in-loop-model-retry.js';
import { buildFailureObservation } from '../decision-shadow/failure-observation.js';
import { TurnInputMailbox } from './turn-input-mailbox.js';
import { ToolCallExecution } from './tool-call-execution.js';
/**
 * Tool results may carry provider-neutral content parts (for example the
 * image returned by read_file). Preserve only the known multimodal shape;
 * arbitrary structured tool values retain their historical JSON text form.
 */
const isToolResultContentParts = (value) => Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === 'object' &&
        part !== null &&
        (('type' in part && part.type === 'text') ||
            ('type' in part && part.type === 'image' && 'image' in part) ||
            ('type' in part && part.type === 'file' && 'file' in part)));
/**
 * Compatibility error for legacy callers without a staged run budget. The loop
 * owns turn counting — the SDK-era `callModelInputFilter` hook is deliberately
 * not reintroduced.
 */
export class MaxTurnsExceededError extends Error {
    maxTurns;
    constructor(maxTurns) {
        super(`Max turns (${maxTurns}) exceeded`);
        this.name = 'MaxTurnsExceededError';
        this.maxTurns = maxTurns;
    }
}
class EventQueue {
    acceptBeforePublish;
    constructor(acceptBeforePublish) {
        this.acceptBeforePublish = acceptBeforePublish;
    }
    #items = [];
    #waiters = [];
    #closed = false;
    #failure;
    push(item) {
        this.acceptBeforePublish?.(item);
        const waiter = this.#waiters.shift();
        if (waiter)
            waiter.resolve({ done: false, value: item });
        else
            this.#items.push(item);
    }
    close(error) {
        this.#closed = true;
        this.#failure = error;
        for (const waiter of this.#waiters.splice(0)) {
            if (error)
                waiter.reject(error);
            else
                waiter.resolve({ done: true, value: undefined });
        }
    }
    next() {
        const item = this.#items.shift();
        if (item !== undefined)
            return Promise.resolve({ done: false, value: item });
        if (this.#closed) {
            if (this.#failure)
                return Promise.reject(this.#failure);
            return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    }
}
/**
 * Process-wide monotonic counter for model-request cost ids.
 *
 * Request ids must be unique across every run in the process: root runs,
 * subagent runs, and approval continuations all feed the same session
 * accumulator, which dedups by id to make event + terminal double-delivery
 * safe. A run-local sequence (as in a per-run counter) would collide across
 * turns and silently drop later turns' records.
 */
let nextCostRequestSeq = 0;
/**
 * Small provider-neutral agent loop. It owns model-turn sequencing and tool
 * execution; providers only implement `StreamedModelTurn`.
 */
export class ApplicationRunLoop {
    #deps;
    #contextCompactionSessionState;
    #turnInputMailbox;
    #activeAbortController = null;
    #activeTurnController = null;
    #segmentGeneration = 0;
    /** The run whose budget an out-of-band grant applies to, held across a pause. */
    #activeRunBudgetState;
    constructor(deps) {
        this.#deps = deps;
        this.#contextCompactionSessionState = deps.contextCompactionSessionState ?? { disabled: false };
        this.#turnInputMailbox = new TurnInputMailbox((message, meta) => this.#deps.logDiagnostic?.(message, meta));
    }
    #observeTerminalFailure(error, request) {
        this.#observeDecisionShadow('failure_triage', () => {
            this.#deps.decisionShadowObserver?.observeTerminalFailure(buildFailureObservation(error, request));
        });
    }
    #observeDecisionShadow(kind, observe) {
        if (!this.#deps.decisionShadowObserver)
            return;
        try {
            observe();
        }
        catch (error) {
            try {
                this.#deps.logDiagnostic?.('Decision shadow observer failed synchronously', { kind, error: error instanceof Error ? error.message : String(error) }, { severity: 'debug', eventType: 'decision_shadow.observer_failed' });
            }
            catch {
                // Observation and its diagnostics must never affect the run.
            }
        }
    }
    /**
     * Declare a turn open, making it steerable before its first run exists.
     *
     * Anything still waiting belongs to a turn that never closed, and can never
     * be admitted now.
     */
    openTurn() {
        this.#turnInputMailbox.openTurn();
    }
    /**
     * Declare the turn over. Whatever is still waiting had no boundary left, so
     * it is handed back for the caller to send as its own turn.
     */
    closeTurn() {
        this.#turnInputMailbox.closeTurn();
    }
    abort() {
        this.#activeTurnController?.abort();
        this.abortSegment();
        // An aborted turn will not resume, so nothing may keep waiting on it.
        this.#turnInputMailbox.abortTurn();
    }
    /**
     * Stop the segment currently streaming without judging the turn's fate.
     *
     * Resuming a paused turn goes through here, so waiting injections survive;
     * only `abort`, which means the turn itself is over, discards them.
     */
    abortSegment() {
        this.#activeAbortController?.abort();
        this.#activeAbortController = null;
    }
    /**
     * Grant one finite continuation extension to the current logical run.
     *
     * The interactive prompt calls this before resuming because it has to show
     * the human a refusal rather than a silent stop. The grant is recorded so the
     * matching `approve` does not charge a second one.
     */
    grantRunBudgetExtension(grantedBy = 'human') {
        const state = this.#activeRunBudgetState;
        if (!state?.runBudget)
            return { granted: false, extensionsGranted: 0 };
        const grant = state.runBudget.grantExtension(grantedBy);
        if (grant.granted)
            state.runBudgetGrantConsumed = true;
        return grant;
    }
    /**
     * Charge this interaction's extension unless a caller already took it.
     *
     * An ungranted arrival here means nobody was prompted — the continuation
     * applier, non-interactive mode, `--auto-approve`. That is a parent-class
     * grant, so it is capped and eventually refuses.
     */
    #takeRunBudgetGrant(state) {
        if (state.runBudgetGrantConsumed) {
            state.runBudgetGrantConsumed = false;
            return true;
        }
        if (!state.runBudget)
            return true;
        return state.runBudget.grantExtension('parent').granted;
    }
    #createToolCallExecution() {
        return new ToolCallExecution({
            toolLifecycle: this.#deps.toolLifecycle,
            resolveMaxParallelToolCalls: this.#deps.resolveMaxParallelToolCalls,
            isMaxTurnsExceeded: (error) => error instanceof MaxTurnsExceededError,
            logDiagnostic: this.#deps.logDiagnostic,
        });
    }
    /**
     * Hand the running turn a user message to send with its next model request.
     *
     * The loop admits it at a request boundary — after the tool results of the
     * current round are in history and before the next request is built — so the
     * model reads it in sequence without the turn being interrupted. Nothing is
     * cancelled, and a tool already running is untouched.
     *
     * The wait spans the whole turn, not just the segment it was offered to: a
     * turn that pauses for an approval resumes as a new segment, and the message
     * is admitted at that segment's first boundary. A caller that declares its
     * turn boundaries with `openTurn`/`closeTurn` extends the wait further still,
     * to the gaps where no segment exists at all — before the first request, and
     * across a retry that restarts the stream.
     *
     * Resolves `'admitted'` once the message has been admitted, `'released'`
     * when the turn ends first (or none is running) — it offered no further
     * request boundary, so the caller must send the message as its own turn
     * instead — and `'retracted'` when `retractSteer` pulled it out first.
     *
     * `options.id` correlates this steer with `retractSteer`/`editSteer`. A
     * steer offered without an id can never be retracted or edited in place —
     * only released or admitted.
     */
    steer(items, options) {
        return this.#turnInputMailbox.offer(items, options);
    }
    /**
     * Drop a still-waiting steer before it reaches a request boundary. Returns
     * `false` when the id is unknown, including when it was already admitted.
     *
     * Invariant: this and `TurnInputMailbox.admitAtRequestBoundary` are both synchronous,
     * and the latter drains the mailbox in a single pass — so the two can never
     * interleave. A retraction is decided in the same tick against whatever is
     * currently pending; once an item has been admitted it is no
     * longer in that array for this method to find. No locking is needed to
     * close the race between "the user retracts" and "the turn admits".
     */
    retractSteer(id) {
        return this.#turnInputMailbox.retract(id);
    }
    /**
     * Replace a waiting steer's items in place, keeping its position (and thus
     * its priority relative to other pending steers) and its id. Returns
     * `false` when the id is unknown, including when it was already admitted —
     * same synchronicity invariant as `retractSteer`.
     */
    editSteer(id, items) {
        return this.#turnInputMailbox.edit(id, items);
    }
    /**
     * Append waiting steers to the turn as ordinary user messages.
     *
     * They enter history and model input exactly as a user turn does — never
     * folded into a tool result — so the provider sees the user speaking after
     * the tool results of the round that was in flight when they typed.
     */
    startStream(agent, input, options = {}) {
        return this.#run(this.#createState(agent, input, options), options);
    }
    #createState(agent, input, options) {
        this.#turnInputMailbox.startStream();
        const state = {
            agent,
            toolExecution: this.#createToolCallExecution(),
            recoveryBudget: options.recoveryBudget,
            input: normalizeInput(input),
            history: normalizeHistory(input),
            compactionHistory: options.compactionHistory,
            usesDeltaHistory: Boolean(options.previousResponseId) && options.disableChainingForAttempt !== true,
            // A response ID is usable only after its provider origin is recorded.
            // This also makes old callers that omit providerId fail closed.
            responseId: options.disableChainingForAttempt !== true &&
                options.providerId &&
                options.supportsConversationChaining === true
                ? options.previousResponseId ?? undefined
                : undefined,
            supportsConversationChaining: options.supportsConversationChaining === true,
            currentProviderId: options.providerId,
            responseProviderId: options.providerId && options.supportsConversationChaining === true && options.previousResponseId
                ? options.providerId
                : undefined,
            requestPreparation: options.requestPreparation,
            requestInputLimit: options.requestInputLimit,
            disableChainingForAttempt: options.disableChainingForAttempt === true,
            sessionId: options.sessionId,
            turnId: options.turnId,
            hookScope: options.hookScope,
            context: options.context,
            approvals: options.approvals ?? new ApprovalLedger(),
            turnCount: 0,
            maxTurns: options.maxTurns,
            completionRepairDeadline: options.completionRepairDeadline,
            ...(options.runBudget
                ? {
                    runBudget: new RunBudget(options.runBudget),
                    onRunBudgetEvent: options.onRunBudgetEvent,
                    wrapUpOnCriticalRunBudget: options.wrapUpOnCriticalRunBudget,
                    runBudgetEscalation: options.runBudget.escalation,
                }
                : {}),
            automaticCompactionsThisRun: 0,
        };
        state.approve = (interruption) => {
            if (isRunBudgetInteraction(interruption)) {
                // Continuing past an exhausted envelope must cost a finite extension no
                // matter which surface answered. A caller that already took the grant
                // (the interactive prompt, which needs the outcome before resuming)
                // marks it consumed; every other path — the continuation applier,
                // non-interactive, --auto-approve — lands here ungranted and takes it
                // now. Without this, an auto-approved 'y' would resume with every stage
                // still latched and never check in again.
                state.runBudgetInteractionDecision = this.#takeRunBudgetGrant(state) ? 'continue' : 'stop';
                return;
            }
            if (state.approvalQueue) {
                state.approvalQueue.push(Object.freeze({ callId: getInterruptionCallId(interruption), interruption, decision: 'approved' }));
                return;
            }
            state.approvalDecision = 'approved';
            state.approvalDecisionCallId = getInterruptionCallId(interruption);
            state.approvalDecisionInterruption = interruption;
        };
        state.reject = (interruption, approvalOptions) => {
            if (isRunBudgetInteraction(interruption)) {
                state.runBudgetInteractionDecision = 'stop';
                return;
            }
            if (state.approvalQueue) {
                state.approvalQueue.push(Object.freeze({
                    callId: getInterruptionCallId(interruption),
                    interruption,
                    decision: 'rejected',
                    message: approvalOptions?.message,
                }));
                return;
            }
            state.approvalDecision = 'rejected';
            state.approvalDecisionCallId = getInterruptionCallId(interruption);
            state.approvalDecisionInterruption = interruption;
            state.approvalMessage = approvalOptions?.message;
        };
        return state;
    }
    /** Root turns use the same loop; session operations never dispatch a run. */
    async runTurn(session) {
        const controller = new AbortController();
        this.#activeTurnController = controller;
        try {
            await this.#runTurn(undefined, session, controller.signal);
        }
        finally {
            if (this.#activeTurnController === controller)
                this.#activeTurnController = null;
        }
    }
    continueRunStream(handle, options = {}) {
        const state = unwrapContinuationHandle(handle);
        if (!state || typeof state !== 'object' || !('agent' in state) || !('input' in state)) {
            throw new Error('Invalid application continuation state');
        }
        if (!state.live?.resume)
            throw new Error('Application turn is not waiting for continuation');
        this.#refreshContinuation(state, options);
        return this.#run(state, options);
    }
    #refreshContinuation(state, options) {
        if (!state.runBudget && options.runBudget) {
            state.runBudget = new RunBudget(options.runBudget);
        }
        if (options.runBudget)
            state.runBudgetEscalation = options.runBudget.escalation;
        if (options.onRunBudgetEvent)
            state.onRunBudgetEvent = options.onRunBudgetEvent;
        if (options.wrapUpOnCriticalRunBudget)
            state.wrapUpOnCriticalRunBudget = true;
        // Response IDs are provider-owned. A handle from before provenance was
        // recorded, a missing providerId, or a provider switch must never forward
        // its opaque ID. In particular, do not use previousResponseId as a
        // compatibility fallback here: its origin cannot be proven.
        const previousProviderId = state.currentProviderId;
        const sameProvider = typeof previousProviderId === 'string' &&
            typeof options.providerId === 'string' &&
            previousProviderId === options.providerId;
        if (!sameProvider || options.supportsConversationChaining !== true) {
            state.responseId = undefined;
            state.responseProviderId = undefined;
        }
        else if (options.previousResponseId) {
            // A same-provider caller may supply a refreshed continuity anchor (for
            // example after persisted-session recovery). Its origin is now proven
            // by the provider identity carried in this continuation state.
            state.responseId = options.previousResponseId;
            state.responseProviderId = options.providerId;
        }
        state.currentProviderId = options.providerId;
        // The turn budget belongs to the run, so a resumed run keeps spending the
        // same one rather than starting over after every approval pause.
        if (typeof state.turnCount !== 'number')
            state.turnCount = 0;
        if (state.maxTurns === undefined)
            state.maxTurns = options.maxTurns;
        state.supportsConversationChaining = options.supportsConversationChaining === true;
        // A continuation receives a fresh immutable snapshot from the session;
        // refresh the preparation closure when supplied, while preserving the
        // root closure for callers that do not provide one again.
        if (options.requestPreparation)
            state.requestPreparation = options.requestPreparation;
        if (options.requestInputLimit)
            state.requestInputLimit = options.requestInputLimit;
        if (options.compactionHistory)
            state.compactionHistory = options.compactionHistory;
        if (options.disableChainingForAttempt === true) {
            state.disableChainingForAttempt = true;
            state.responseId = undefined;
            state.responseProviderId = undefined;
        }
        if (options.sessionId !== undefined)
            state.sessionId = options.sessionId;
        if (options.turnId !== undefined)
            state.turnId = options.turnId;
        if (options.hookScope !== undefined)
            state.hookScope = options.hookScope;
    }
    #createView(state, options, acceptEvent) {
        const queue = new EventQueue(acceptEvent);
        const segmentGeneration = ++this.#segmentGeneration;
        if (!state.live)
            this.abortSegment();
        const controller = new AbortController();
        this.#activeAbortController = controller;
        this.#turnInputMailbox.startSegment();
        state.runBudget?.resume();
        if (options.signal) {
            if (options.signal.aborted)
                controller.abort();
            else
                options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        const effectiveOptions = { ...options, signal: controller.signal };
        const toolContext = {
            context: state.context,
            approvals: state.approvals,
            signal: effectiveOptions.signal,
            // A getter, not a snapshot: the context object outlives every turn, and
            // tools read it while deciding whether to warn about the turn budget.
            get turn() {
                return { count: state.turnCount, max: state.maxTurns };
            },
            get budget() {
                return state.runBudget
                    ? {
                        takeSoftEvidence: () => state.runBudget?.takeSoftEvidence(),
                        takeStallEvidence: () => state.runBudget?.takeStallEvidence(),
                        remainingPolicy: () => state.runBudget?.remainingPolicy(),
                    }
                    : undefined;
            },
        };
        const output = [];
        const stream = createAgentStream({
            [Symbol.asyncIterator]: () => ({ next: () => queue.next() }),
            completed: Promise.resolve(undefined),
            history: state.history,
            newItems: output,
            output,
            finalOutput: undefined,
            lastResponseId: state.responseId ?? null,
            interruptions: [],
            state: createContinuationHandle(state),
            rawResponses: [],
            terminalCause: undefined,
            get runUsage() {
                return state.usage;
            },
            get runCostRecords() {
                return state.costRecords ?? [];
            },
        });
        let resolveSegment;
        let rejectSegment;
        stream.completed = new Promise((resolve, reject) => {
            resolveSegment = resolve;
            rejectSegment = reject;
        });
        // The iterator may report a failure before the caller observes completed.
        void stream.completed.catch(() => undefined);
        const current = {
            state,
            stream,
            queue,
            options: effectiveOptions,
            toolContext,
            requestAbortController: controller,
            generation: segmentGeneration,
            resolveSegment,
            rejectSegment,
        };
        this.#activeRunBudgetState = state.runBudget ? state : undefined;
        return current;
    }
    #run(state, options) {
        const current = this.#createView(state, options);
        if (state.live) {
            const resume = state.live.resume;
            Object.assign(state.live, current, { resume: undefined });
            resume();
        }
        else {
            state.live = current;
            void this.#runTurn(current).then((value) => this.#settleSegment(current, value), (error) => this.#settleSegment(current, undefined, error));
        }
        return current.stream;
    }
    #observe(context) {
        context.session.beginSegment(context.stream);
        context.observation = context.session.consume(context.stream);
        void context.observation.catch(() => undefined);
    }
    async #completeTurn(context) {
        const value = finish(context.stream, context.state, context.queue);
        if (context.session) {
            this.#settleSegment(context, value);
            await context.observation;
            await context.session.completed(context.stream);
        }
        return value;
    }
    /** Complete an event view; a pause leaves the owning async task alive. */
    #settleSegment(context, value, error, waiting = false) {
        const { state, stream, queue, generation } = context;
        if (error === undefined)
            context.session?.acceptSegment(stream);
        state.runBudget?.pause();
        const cancelled = error instanceof Error && error.name === 'AbortError';
        const paused = (waiting || context.resume !== undefined) && !cancelled && error === undefined;
        if (error !== undefined) {
            stream.cancelled = cancelled;
            queue.close(error);
            context.rejectSegment(error);
        }
        else {
            context.resolveSegment(value);
        }
        if (generation !== this.#segmentGeneration)
            return;
        if (!paused && this.#activeAbortController === context.requestAbortController)
            this.#activeAbortController = null;
        this.#turnInputMailbox.settleSegment({
            paused,
            reason: {
                pendingApprovals: state.toolExecution.pendingApprovals.length,
                pendingBudgetInteraction: state.pendingRunBudgetInteraction !== undefined,
                cancelled,
                error: error instanceof Error ? error.name : error ? String(error) : undefined,
                turnCount: state.turnCount,
            },
        });
        if (!paused && this.#activeRunBudgetState === state)
            this.#activeRunBudgetState = undefined;
    }
    /** Publish a paused view and suspend here until its owner reconnects or cancels. */
    async #waitForDecision(context) {
        if (context.session) {
            this.#settleSegment(context, finish(context.stream, context.state, context.queue), undefined, true);
            await context.observation;
            const options = await context.session.interrupted(context.stream);
            this.#assertLive(context);
            this.#refreshContinuation(context.state, options);
            Object.assign(context, this.#createView(context.state, { ...options, signal: context.turnSignal }, (event) => context.session.acceptEvent(event)));
            this.#observe(context);
            return;
        }
        const { state, stream, queue, options } = context;
        await new Promise((resolve, reject) => {
            const signal = options.signal;
            const abort = () => {
                context.resume = undefined;
                reject(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
            };
            context.resume = () => {
                signal?.removeEventListener('abort', abort);
                resolve();
            };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) {
                abort();
                return;
            }
            this.#settleSegment(context, finish(stream, state, queue));
        });
    }
    /** A budget decision resumes this exact boundary without recounting it. */
    async #waitForBudget(context) {
        const { state } = context;
        while (state.pendingRunBudgetInteraction) {
            if (state.runBudgetInteractionDecision === 'stop') {
                if ((context.session?.recordBudgetStopCause || this.#deps.recordBudgetStopCause) && !state.terminalCause)
                    state.terminalCause = 'budget_exhausted';
                state.pendingRunBudgetInteraction = undefined;
                state.runBudgetInteractionDecision = undefined;
                return true;
            }
            if (state.runBudgetInteractionDecision === 'continue') {
                state.pendingRunBudgetInteraction = undefined;
                state.runBudgetInteractionDecision = undefined;
                return false;
            }
            context.stream.interruptions = [state.pendingRunBudgetInteraction];
            await this.#waitForDecision(context);
        }
        return false;
    }
    /** Route boundary advice through the same admission lane as mode notices. */
    #queuePendingSystemNotice(text) {
        this.#turnInputMailbox.enqueueInternal({ type: 'message', role: 'user', content: `[Mode Notice] ${text}` });
    }
    #admitPendingSteers(state, stream, queue) {
        this.#turnInputMailbox.admitAtRequestBoundary((item) => {
            const text = typeof item.content === 'string'
                ? item.content
                : Array.isArray(item.content)
                    ? item.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
                    : '';
            if (item.role === 'user' && !text.startsWith('[Mode Notice]'))
                state.completionRepairDeadline = undefined;
            state.history.push(item);
            state.input.push(...normalizeApplicationInput([item]));
            outputPush(stream, queue, { type: 'item', item });
        }, state.turnCount);
    }
    /** The single model → tools → model cycle, shared by root and nested turns. */
    async #runTurn(context, session, turnSignal) {
        while (true) {
            try {
                turnSignal?.throwIfAborted();
                if (!context) {
                    const start = await session.prepare(turnSignal);
                    turnSignal?.throwIfAborted();
                    if (!start)
                        return;
                    const options = { ...start.options, signal: turnSignal };
                    const state = this.#createState(start.agent, start.input, options);
                    if (session.approvalBatch)
                        state.approvalQueue = [];
                    this.#refreshContinuation(state, options);
                    context = this.#createView(state, options, (event) => session.acceptEvent(event));
                    context.session = session;
                    context.turnSignal = turnSignal;
                    state.live = context;
                    this.#observe(context);
                }
                this.#assertLive(context);
                // New explicit user authority supersedes a harness repair continuation before its deadline is applied.
                this.#admitPendingSteers(context.state, context.stream, context.queue);
                if (await this.#withinRepairDeadline(context, () => this.#prepareRequest(context)))
                    return await this.#completeTurn(context);
                const response = await this.#withinRepairDeadline(context, () => this.#askModel(context));
                this.#assertLive(context);
                const calls = this.#recordResponse(context, response);
                if (await this.#withinRepairDeadline(context, () => this.#executeTools(context, response, calls)))
                    return await this.#completeTurn(context);
                if (calls.length === 0 && (await this.#finishTurn(context)))
                    return await this.#completeTurn(context);
            }
            catch (error) {
                if (context?.completionRepairExpired) {
                    context.state.terminalCause = 'completion_verification_blocked';
                    this.#appendStopNotice(context, 'Completion verification blocked: the repair task deadline expired. The durable goal remains active.');
                    return await this.#completeTurn(context);
                }
                if (!session)
                    throw error;
                if (context) {
                    this.#settleSegment(context, undefined, error);
                    await context.observation?.catch(() => undefined);
                }
                if (session.isFatalError?.(error))
                    throw error;
                turnSignal?.throwIfAborted();
                if (!(await session.recover(error)))
                    return;
                context = undefined;
            }
        }
    }
    async #withinRepairDeadline(context, operation) {
        const deadline = context.state.completionRepairDeadline;
        if (deadline === undefined)
            return operation();
        let timer;
        try {
            return await Promise.race([
                new Promise((_resolve, reject) => {
                    const expire = () => {
                        if (context.state.completionRepairDeadline !== deadline)
                            return;
                        context.completionRepairExpired = true;
                        context.requestAbortController.abort();
                        reject(new Error('Completion repair deadline exceeded'));
                    };
                    if (Date.now() >= deadline)
                        expire();
                    else
                        timer = setTimeout(expire, deadline - Date.now());
                }),
                Promise.resolve().then(() => {
                    if (context.completionRepairExpired)
                        throw new Error('Completion repair deadline exceeded');
                    return operation();
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    #appendStopNotice(context, notice) {
        const text = `\n\n${notice}`;
        context.stream.finalOutput = (context.stream.finalOutput ?? '') + text;
        context.queue.push({ type: 'text_delta', text });
    }
    #assertLive(context) {
        if (context.options.signal?.aborted)
            throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
    }
    /** Admit input and prepare context once for the next logical model round. */
    async #prepareRequest(context) {
        let { state, stream, queue, options } = context;
        // The request boundary: every tool result of the previous round is in
        // history, and the next request has not been built. A user message
        // admitted here reaches the model in sequence, mid-turn.
        this.#admitPendingSteers(state, stream, queue);
        this.#evaluateRunBudget(state, stream, queue);
        if (await this.#waitForBudget(context))
            return true;
        ({ state, stream, queue, options } = context);
        const compactionHistoryResult = state.usesDeltaHistory
            ? state.compactionHistory
                ? mergeChainedCompactionHistory(state.compactionHistory, state.history)
                : { kind: 'skipped', reason: 'missing_snapshot' }
            : { kind: 'ready', history: state.history };
        const boundaryDecision = options.onRequestBoundary?.(compactionHistoryResult.kind === 'ready' ? compactionHistoryResult.history : state.history, (text) => this.#queuePendingSystemNotice(text), {
            ...(state.lastCompletedInputTokens !== undefined
                ? { lastCompletedInputTokens: state.lastCompletedInputTokens }
                : {}),
            ...(compactionHistoryResult.kind === 'skipped' ? { compactionSkipReason: compactionHistoryResult.reason } : {}),
        });
        const compactionHistory = compactionHistoryResult.kind === 'ready' ? compactionHistoryResult.history : undefined;
        if (options.boundaryCompaction && compactionHistory && !boundaryDecision?.deferCompaction) {
            const compactionStartedAt = Date.now();
            let costsRecordedLive = false;
            const compaction = await options.boundaryCompaction.compact({
                history: compactionHistory,
                instructions: state.agent.resolveInstructionsForRequest?.() ?? state.agent.instructions,
                tools: toModelTools(state.agent.tools),
                recordCostRecords: (records) => {
                    if (records.length) {
                        costsRecordedLive = true;
                        state.costRecords ??= [];
                        state.costRecords.push(...records);
                        for (const record of records)
                            queue.push({ type: 'cost_update', record });
                        this.#evaluateRunBudget(state, stream, queue);
                    }
                    return !state.pendingRunBudgetInteraction && !state.criticalWrapUpPending;
                },
                automaticCompactionsThisRun: state.automaticCompactionsThisRun ?? 0,
                lastCompletedInputTokens: state.lastCompletedInputTokens,
                signal: options.signal,
                onStarted: (provider) => outputPush(stream, queue, { type: 'context_compaction_started', provider, strategy: 'local' }),
            });
            if (compaction.kind !== 'unchanged' && !costsRecordedLive && compaction.costRecords?.length) {
                state.costRecords ??= [];
                state.costRecords.push(...compaction.costRecords);
            }
            if (compaction.kind === 'compacted') {
                state.inputUsageInvalidatedByCompaction = true;
                state.lastCompletedInputTokens = undefined;
                state.compactedDuringRun = true;
                state.history.splice(0, state.history.length, ...compaction.history);
                state.input.splice(0, state.input.length, ...normalizeApplicationInput(compaction.modelInput));
                state.responseId = undefined;
                state.responseProviderId = undefined;
                state.usesDeltaHistory = false;
                state.automaticCompactionsThisRun = (state.automaticCompactionsThisRun ?? 0) + 1;
                outputPush(stream, queue, {
                    type: 'context_compaction_completed',
                    provider: state.currentProviderId ?? 'unknown',
                    strategy: 'local',
                    durationMs: Math.max(0, Date.now() - compactionStartedAt),
                });
            }
            else if (compaction.kind === 'failed') {
                outputPush(stream, queue, {
                    type: 'context_compaction_failed',
                    provider: compaction.provider,
                    strategy: 'local',
                    durationMs: Math.max(0, Date.now() - compactionStartedAt),
                });
                if (compaction.error)
                    throw compaction.error;
            }
            else if (compaction.notice && compaction.notice !== state.compactionNotice) {
                state.compactionNotice = compaction.notice;
                this.#queuePendingSystemNotice(compaction.notice);
            }
            // Summarization is an asynchronous part of this same request
            // boundary. Admit anything that arrived while it was in flight after
            // applying a replacement, so the steer cannot be overwritten by the
            // checkpoint or miss a terminal model request.
            this.#admitPendingSteers(state, stream, queue);
            this.#evaluateRunBudget(state, stream, queue);
            if (await this.#waitForBudget(context))
                return true;
            ({ state, stream, queue, options } = context);
        }
        this.#admitPendingSteers(state, stream, queue);
        state.turnCount += 1;
        this.#evaluateRunBudget(state, stream, queue);
        if (await this.#waitForBudget(context))
            return true;
        ({ state, stream, queue, options } = context);
        // Retain the legacy error only for callers that have not adopted staged
        // budgets. A configured run budget turns the same count into critical
        // evidence and lets the decision surface choose what happens next.
        if (!state.runBudget && state.maxTurns !== undefined && state.turnCount > state.maxTurns) {
            throw new MaxTurnsExceededError(state.maxTurns);
        }
        return false;
    }
    /** Own streaming and safe request attempts; never dispatch tools here. */
    async #askModel(context) {
        const { state, stream, queue, options, requestAbortController } = context;
        const resolution = Promise.resolve(this.#deps.resolveModel(state.agent.model));
        const model = (context.session?.abortPendingModelReads || this.#deps.abortPendingModelReads) && options.signal
            ? await waitForAbortableRead(resolution, options.signal, context.session?.onDetachedModelRead ?? this.#deps.onDetachedModelRead)
            : await resolution;
        const maxRetries = state.agent.modelSettings?.retry?.maxRetries ?? 0;
        let attempt = 0;
        let streamedToolCalls = [];
        let completion;
        let sawToolCall = false;
        let activeRequestId = '';
        let activeRequest;
        let pendingNativeReasoning;
        let deferredNativeReasoning = [];
        let criticalWrapUp = false;
        while (true) {
            streamedToolCalls = [];
            completion = undefined;
            sawToolCall = false;
            pendingNativeReasoning = undefined;
            deferredNativeReasoning = [];
            // Stable process-unique request id, allocated immediately before dispatch
            // so a cost record can be settled exactly once (success or failure).
            activeRequestId = this.#nextRequestId();
            const requestId = activeRequestId;
            const outputLengthBefore = stream.output.length;
            const newItemsLengthBefore = stream.newItems.length;
            const inputLengthBefore = state.input.length;
            const historyLengthBefore = state.history.length;
            const criticalWrapUpDispatchedBefore = state.criticalWrapUpDispatched;
            let provisionalTextCharacters = 0;
            let provisionalReasoningCharacters = 0;
            let provisionalTextDeltas = 0;
            let provisionalReasoningDeltas = 0;
            let lastTextPartId;
            criticalWrapUp = state.criticalWrapUpPending === true && state.criticalWrapUpDispatched !== true;
            if (criticalWrapUp)
                state.criticalWrapUpDispatched = true;
            const disableChaining = state.disableChainingForAttempt === true;
            if (disableChaining) {
                state.disableChainingForAttempt = false;
                state.responseId = undefined;
                state.responseProviderId = undefined;
            }
            // A per-request signal lets a recoverable guard trip cancel only this
            // provider request; the segment signal still cancels everything.
            const requestSignal = new AbortController();
            const abortRequest = () => requestSignal.abort();
            if (options.signal?.aborted)
                requestSignal.abort();
            else
                options.signal?.addEventListener('abort', abortRequest, { once: true });
            const requestInstructions = state.agent.resolveInstructionsForRequest?.() ?? state.agent.instructions;
            // Same synchronous step as the instructions above, so the snapshot is
            // exactly the state the model is shown in this request.
            state.requestSnapshot = state.agent.resolveRequestSnapshot?.();
            const requestCatalog = getCatalogModel(state.currentProviderId ?? 'openai', state.agent.model);
            const effectiveOutput = resolveRequestOutput(requestCatalog, state.agent.modelSettings?.maxTokens);
            const request = {
                instructions: criticalWrapUp
                    ? `${requestInstructions}\n\nBudget containment is terminal. Do not call tools. In this one final response, summarize what you completed, the evidence you have, and what remains.`
                    : requestInstructions,
                ...(state.supportsConversationChaining &&
                    !disableChaining &&
                    state.responseId &&
                    state.responseProviderId !== undefined &&
                    state.responseProviderId === state.currentProviderId
                    ? { previousResponseId: state.responseId }
                    : {}),
                ...(disableChaining ? { disableChaining: true } : {}),
                input: projectModelRequestHistory(state.input),
                tools: toModelTools(criticalWrapUp ? [] : state.agent.tools),
                applicationTools: criticalWrapUp ? [] : state.agent.tools,
                ...(state.agent.modelSettings?.temperature !== undefined
                    ? { temperature: state.agent.modelSettings.temperature }
                    : {}),
                ...(state.agent.modelSettings?.reasoning ? { reasoning: state.agent.modelSettings.reasoning } : {}),
                ...(effectiveOutput !== undefined ? { maxTokens: effectiveOutput } : {}),
                ...(state.agent.outputType !== undefined ? { outputType: state.agent.outputType } : {}),
                ...(state.agent.modelSettings?.codex ? { codex: state.agent.modelSettings.codex } : {}),
                ...(state.agent.modelSettings?.providerData
                    ? {
                        providerOptions: this.#contextCompactionSessionState.disabled
                            ? Object.fromEntries(Object.entries(state.agent.modelSettings.providerData).filter(([key]) => key !== 'contextCompaction'))
                            : state.agent.modelSettings.providerData,
                    }
                    : {}),
                signal: requestSignal.signal,
                ...(state.recoveryBudget ? { recoveryBudget: state.recoveryBudget } : {}),
            };
            activeRequest = request;
            const generationGuard = new GenerationGuard({
                maxOutputCharacters: state.agent.modelSettings?.maxStreamOutputChars,
                maxTextCharacters: state.agent.modelSettings?.maxStreamOutputChars,
                maxReasoningCharacters: state.agent.modelSettings?.maxStreamOutputChars,
                maxToolArgumentCharacters: state.agent.modelSettings?.maxStreamOutputChars,
                maxCumulativeToolArgumentCharacters: state.agent.modelSettings?.maxStreamOutputChars,
                requestDeadlineMs: state.agent.modelSettings?.maxModelRequestDurationMs,
                maxStreamIdleMs: state.agent.modelSettings?.maxModelStreamIdleMs,
                ...options.generationGuard,
            });
            const consume = async () => {
                const deadline = new GenerationStreamDeadlines({ totalMs: generationGuard.requestDeadlineMs, idleMs: generationGuard.maxStreamIdleMs }, () => requestAbortController.abort(), () => generationGuard.progress);
                const toolArgumentRunaway = isLunaChainedRequest(state, request)
                    ? new ToolArgumentRunawayGuard({
                        ...DEFAULT_TOOL_ARGUMENT_RUNAWAY_SIGNATURE,
                        timeoutMs: generationGuard.toolArgumentRunawayMs,
                    }, () => requestAbortController.abort())
                    : undefined;
                let iterator;
                let iteratorFinished = false;
                try {
                    options.signal?.throwIfAborted();
                    context.session?.onModelDispatch?.({
                        requestId,
                        providerId: state.currentProviderId,
                        model: state.agent.model,
                    });
                    iterator = model.stream(request)[Symbol.asyncIterator]();
                    while (true) {
                        const read = iterator.next();
                        const abortReads = context.session?.abortPendingModelReads || this.#deps.abortPendingModelReads;
                        const detached = context.session?.onDetachedModelRead ?? this.#deps.onDetachedModelRead;
                        const nextOperation = abortReads && options.signal ? waitForAbortableRead(read, options.signal, detached) : read;
                        const next = await deadline.wait(toolArgumentRunaway ? toolArgumentRunaway.wait(nextOperation) : nextOperation);
                        if (next.done) {
                            iteratorFinished = true;
                            return;
                        }
                        // Any streamed event is transport activity: re-arm the inactivity
                        // window so long legitimate reasoning is never mistaken for a stall.
                        deadline.recordActivity();
                        const event = next.value;
                        if (event.type === 'completion') {
                            toolArgumentRunaway?.observeToolCallCompleted();
                            generationGuard.observeCompletion(event.output);
                            completion = event;
                            continue;
                        }
                        if (event.type === 'text_delta') {
                            const startsNewPart = event.partId !== undefined &&
                                lastTextPartId !== undefined &&
                                event.partId !== lastTextPartId &&
                                event.text.length > 0;
                            if (event.partId !== undefined && event.text.length > 0)
                                lastTextPartId = event.partId;
                            const text = startsNewPart ? `${ASSISTANT_TEXT_PART_SEPARATOR}${event.text}` : event.text;
                            toolArgumentRunaway?.observeText();
                            generationGuard.observeText(text);
                            provisionalTextCharacters += text.length;
                            provisionalTextDeltas++;
                            outputPush(stream, queue, { type: 'text_delta', text });
                            continue;
                        }
                        if (event.type === 'codex_rate_limits') {
                            outputPush(stream, queue, { type: 'codex_rate_limits', rateLimits: event.rateLimits });
                            continue;
                        }
                        if (event.type === 'reasoning_started') {
                            outputPush(stream, queue, {
                                type: 'reasoning_started',
                                ...(event.id !== undefined ? { id: event.id } : {}),
                            });
                            continue;
                        }
                        if (event.type === 'reasoning_delta') {
                            const accepted = generationGuard.observeReasoning(event.text);
                            if (!accepted)
                                continue;
                            const forwarded = accepted === event.text ? event : { ...event, text: accepted };
                            pendingNativeReasoning = appendNativeReasoning(pendingNativeReasoning, forwarded);
                            provisionalReasoningCharacters += accepted.length;
                            provisionalReasoningDeltas++;
                            outputPush(stream, queue, { type: 'reasoning_delta', text: accepted });
                            continue;
                        }
                        if (event.type === 'tool_call_streaming_delta') {
                            toolArgumentRunaway?.observeToolArgumentProgress(event.argumentCharCount);
                            generationGuard.observeToolArgumentProgress(event.argumentCharCount);
                            outputPush(stream, queue, event);
                            continue;
                        }
                        if (event.type === 'context_compaction_started' || event.type === 'context_compaction_completed') {
                            outputPush(stream, queue, event);
                            continue;
                        }
                        if (event.type === 'tool_call') {
                            toolArgumentRunaway?.observeToolCallCompleted();
                            generationGuard.observeToolCall(event.arguments);
                            // The authoritative completion may introduce a native
                            // replacement boundary before this call's reasoning.
                            if (pendingNativeReasoning)
                                deferredNativeReasoning.push(pendingNativeReasoning);
                            pendingNativeReasoning = undefined;
                            sawToolCall = true;
                            streamedToolCalls.push(event);
                        }
                    }
                }
                finally {
                    deadline.dispose();
                    toolArgumentRunaway?.dispose();
                    if (iterator && !iteratorFinished) {
                        if (context.session?.abortPendingModelReads || this.#deps.abortPendingModelReads) {
                            try {
                                const returned = iterator.return?.();
                                if (returned) {
                                    const operation = Promise.resolve(returned);
                                    if (options.signal?.aborted)
                                        (context.session?.onDetachedModelRead ?? this.#deps.onDetachedModelRead)?.(operation);
                                    void operation.catch(() => undefined);
                                }
                            }
                            catch {
                                /* Best-effort late iterator cleanup. */
                            }
                        }
                        else
                            void iterator.return?.().catch(() => undefined);
                    }
                }
            };
            const dispatch = async () => {
                state.requestPreparation?.prepare(request);
                // A response ID can be established after a self-contained request.
                // It does not make this run's full history a delta needing a snapshot.
                const needsChainedSnapshot = Boolean(request.previousResponseId && state.usesDeltaHistory);
                const fullContext = needsChainedSnapshot && state.compactionHistory
                    ? mergeChainedCompactionHistory(state.compactionHistory, state.history)
                    : undefined;
                const contextCatalog = getCatalogModel(state.currentProviderId ?? 'openai', state.agent.model);
                enforceRequestInputLimit({
                    contextWindow: contextCatalog?.contextWindow,
                    maxOutputTokens: request.maxTokens,
                    limit: state.requestInputLimit ? state.requestInputLimit() : state.agent.modelSettings?.maxRequestInputTokens,
                    history: fullContext?.kind === 'ready'
                        ? fullContext.history
                        : needsChainedSnapshot
                            ? [...(state.compactionHistory ?? []), ...request.input]
                            : request.input,
                    instructions: request.instructions ?? '',
                    tools: request.tools,
                    lastCompletedInputTokens: state.inputUsageInvalidatedByCompaction
                        ? undefined
                        : state.lastCompletedInputTokens,
                    chainedContextKnown: !needsChainedSnapshot || fullContext?.kind === 'ready',
                });
                await consume();
            };
            try {
                if (state.requestPreparation)
                    await state.requestPreparation.run(dispatch);
                else
                    await dispatch();
                break;
            }
            catch (error) {
                if (error instanceof RequestInputLimitError) {
                    this.#deps.logDiagnostic?.('Request input admission refused', {
                        code: error.code,
                        action: error.action,
                        reason: error.reason,
                        guardClass: 'admission',
                        setting: 'agent.maxRequestInputTokens',
                        executionScope: state.hookScope ?? 'root',
                        recovery: 'retained_work',
                        limit: error.limit,
                        estimatedTokens: error.estimatedTokens,
                        observedTokens: error.observedTokens,
                        capacity: error.capacity,
                        outputReserve: error.outputReserve,
                        estimationReserve: error.estimationReserve,
                    });
                    throw error;
                }
                if (isProviderContextOverflow(error)) {
                    this.#observeTerminalFailure(error, {
                        requestId: activeRequestId,
                        provider: state.currentProviderId,
                        model: state.agent.model,
                        tier: resolveServiceTier(request),
                    });
                    throw new ProviderContextOverflowError(error);
                }
                const recoverOversizedToolArgument = isOversizedToolArgumentTrip(error) &&
                    (state.oversizedToolArgumentRecoveries ?? 0) < MAX_OVERSIZED_TOOL_ARGUMENT_RECOVERIES &&
                    !options.signal?.aborted;
                if (recoverOversizedToolArgument)
                    requestSignal.abort();
                else if (error instanceof GenerationGuardError)
                    requestAbortController.abort();
                const decision = classifyInLoopModelRetry(error, attempt, maxRetries, Math.random, {
                    previousResponseId: activeRequest?.previousResponseId,
                });
                const rollbackProvisionalAttempt = () => {
                    stream.output.splice(outputLengthBefore);
                    if (stream.newItems !== stream.output) {
                        stream.newItems.splice(newItemsLengthBefore);
                    }
                    if (provisionalTextDeltas > 0 || provisionalReasoningDeltas > 0) {
                        queue.push({
                            type: 'model_attempt_rollback',
                            textCharacters: provisionalTextCharacters,
                            reasoningCharacters: provisionalReasoningCharacters,
                            textDeltas: provisionalTextDeltas,
                            reasoningDeltas: provisionalReasoningDeltas,
                        });
                    }
                };
                if (recoverOversizedToolArgument) {
                    // No tool ran: a call is dispatched only after its arguments
                    // complete. Discard the partial response and ask for smaller calls.
                    state.oversizedToolArgumentRecoveries = (state.oversizedToolArgumentRecoveries ?? 0) + 1;
                    state.input.splice(inputLengthBefore);
                    state.history.splice(historyLengthBefore);
                    state.criticalWrapUpDispatched = criticalWrapUpDispatchedBefore;
                    rollbackProvisionalAttempt();
                    this.#deps.logDiagnostic?.('Recovering oversized tool argument in run loop', {
                        code: error.code,
                        recovery: state.oversizedToolArgumentRecoveries,
                        maxRecoveries: MAX_OVERSIZED_TOOL_ARGUMENT_RECOVERIES,
                    });
                    this.#queuePendingSystemNotice(oversizedToolArgumentNotice(error.message));
                    this.#admitPendingSteers(state, stream, queue);
                    continue;
                }
                if (decision.retryable && !options.signal?.aborted) {
                    attempt++;
                    state.input.splice(inputLengthBefore);
                    state.history.splice(historyLengthBefore);
                    state.criticalWrapUpDispatched = criticalWrapUpDispatchedBefore;
                    rollbackProvisionalAttempt();
                    if (decision.kind === 'chain_recovery') {
                        state.disableChainingForAttempt = true;
                        state.responseId = undefined;
                        state.responseProviderId = undefined;
                    }
                    this.#deps.logDiagnostic?.('Retrying model request in run loop', {
                        attempt,
                        maxRetries,
                        kind: decision.kind,
                        delayMs: decision.delayMs,
                        error: describeError(error),
                    });
                    await (this.#deps.waitBeforeModelRetry ?? sleepWithAbort)(decision.delayMs, options.signal);
                    continue;
                }
                // Session recovery owns full-history rebuild for a chained delta.
                // Retract this cycle's provisional tokens so a later chain_recovery
                // does not append a second answer after a half-sentence.
                if (!decision.retryable && decision.reason === 'chained_delta_not_self_contained') {
                    rollbackProvisionalAttempt();
                }
                // Dispatch began, but no terminal completion was accepted. Record an
                // unpriced marker so the summary stays honest (partial) rather than
                // appearing exact. Observational only: the error still propagates.
                const cancelled = error instanceof Error && error.name === 'AbortError';
                const record = this.#appendCostRecord(state, {
                    requestId,
                    provider: state.currentProviderId,
                    model: state.agent.model,
                    tier: resolveServiceTier(request),
                    outcome: cancelled ? 'cancelled' : 'failed',
                });
                // Only the live queue sees cost records: `output`/`newItems` feed
                // persistence and replay, and a cost event must never become a
                // restored history item.
                queue.push({ type: 'cost_update', record });
                this.#evaluateRunBudget(state, stream, queue);
                this.#observeTerminalFailure(error, {
                    requestId,
                    provider: state.currentProviderId,
                    model: state.agent.model,
                    tier: resolveServiceTier(request),
                });
                throw error;
            }
            finally {
                options.signal?.removeEventListener('abort', abortRequest);
            }
        }
        return {
            streamedToolCalls,
            completion,
            sawToolCall,
            activeRequestId,
            activeRequest,
            pendingNativeReasoning,
            deferredNativeReasoning,
            criticalWrapUp,
        };
    }
    /** Accept response facts before any tool from that response can execute. */
    #recordResponse(context, response) {
        const { state, stream, queue } = context;
        const { streamedToolCalls, completion, sawToolCall, activeRequestId, activeRequest, deferredNativeReasoning, criticalWrapUp, } = response;
        let { pendingNativeReasoning } = response;
        if (!completion) {
            if (streamedToolCalls.length === 0) {
                const error = new Error('Application model turn ended without completion');
                this.#observeTerminalFailure(error, {
                    requestId: activeRequestId,
                    provider: state.currentProviderId,
                    model: state.agent.model,
                    tier: activeRequest ? resolveServiceTier(activeRequest) : 'standard',
                });
                throw error;
            }
            if (!criticalWrapUp) {
                for (const reasoning of deferredNativeReasoning)
                    commitPendingNativeReasoning(state, stream, queue, reasoning);
                commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
            }
            return criticalWrapUp ? [] : streamedToolCalls;
        }
        const finalCompletion = completion;
        // A terminal response ends recovery, unlike partial tokens or tool
        // activity. Later failures must not inherit an old episode's deadline.
        state.recoveryBudget?.noteModelResponseCompleted();
        // Commit the authoritative terminal state before handling terminal-only
        // tool calls. Approval may pause immediately after this point, and the
        // continuation must still carry the response that produced the calls.
        // Response IDs are provider-chain state, not generic run metadata. Keep
        // them out of continuation handles for providers that do not support
        // chaining, while still exposing the completed provider response on the
        // current stream for diagnostics.
        if (state.supportsConversationChaining && state.currentProviderId !== undefined) {
            state.responseId = finalCompletion.responseId;
            state.responseProviderId = state.currentProviderId;
        }
        else {
            state.responseId = undefined;
            state.responseProviderId = undefined;
        }
        let normalizedCompletionUsage;
        const upstreamProvider = extractAiSdkUpstreamProvider(finalCompletion.providerMetadata);
        if (finalCompletion.usage !== undefined) {
            normalizedCompletionUsage = normalizeModelUsage(finalCompletion.usage);
            if (upstreamProvider) {
                if (normalizedCompletionUsage) {
                    normalizedCompletionUsage.upstream_provider = upstreamProvider;
                }
                else {
                    normalizedCompletionUsage = { upstream_provider: upstreamProvider };
                }
            }
            if (normalizedCompletionUsage) {
                if (normalizedCompletionUsage.prompt_tokens !== undefined) {
                    state.lastCompletedInputTokens = normalizedCompletionUsage.prompt_tokens;
                    state.inputUsageInvalidatedByCompaction = false;
                }
                const accumulated = addTokenUsage(normalizeModelUsage(state.usage), normalizedCompletionUsage);
                state.usage = {
                    ...(accumulated.prompt_tokens !== undefined ? { inputTokens: accumulated.prompt_tokens } : {}),
                    ...(accumulated.completion_tokens !== undefined ? { outputTokens: accumulated.completion_tokens } : {}),
                    // `total_tokens` is the billable normalized total, including cache
                    // creation tokens. Keep it alongside the application aliases so the
                    // authoritative run accumulator never reconstructs a smaller total.
                    ...(accumulated.total_tokens !== undefined ? { totalTokens: accumulated.total_tokens } : {}),
                    ...(accumulated.cache_read_tokens !== undefined ? { cachedInputTokens: accumulated.cache_read_tokens } : {}),
                    ...(accumulated.cache_creation_tokens !== undefined
                        ? { cacheWriteTokens: accumulated.cache_creation_tokens }
                        : {}),
                };
            }
            else {
                // Providers may carry a future/opaque usage shape. Preserve the old
                // pass-through behavior when normalization cannot recognize it.
                state.usage = finalCompletion.usage;
            }
        }
        else if (upstreamProvider) {
            normalizedCompletionUsage = { upstream_provider: upstreamProvider };
        }
        else {
            normalizedCompletionUsage = undefined;
        }
        // Attribute cost while the dispatched request's identity is still known.
        // Emit it immediately so the UI can show this request's cost before the
        // run ends; the terminal result re-delivers the cumulative record list
        // and the session accumulator ignores the duplicates by request id.
        // Only the live queue sees the event: `output`/`newItems` feed
        // persistence and replay, and a cost event must never become a restored
        // history item.
        const record = this.#appendCostRecord(state, {
            requestId: activeRequestId,
            provider: state.currentProviderId,
            model: state.agent.model,
            tier: activeRequest ? resolveServiceTier(activeRequest) : 'standard',
            outcome: 'completed',
            usage: normalizedCompletionUsage,
            providerUsd: finalCompletion.costUsd,
        });
        queue.push({ type: 'cost_update', record });
        // Cost and usage arrive in the same completion metadata, so surface both
        // live. The footer is a per-request indicator: emit this request's own
        // usage, never the run accumulator in `state.usage`.
        if (normalizedCompletionUsage)
            queue.push({ type: 'usage_update', usage: normalizedCompletionUsage });
        this.#evaluateRunBudget(state, stream, queue);
        stream.lastResponseId = finalCompletion.responseId;
        stream.rawResponses?.push(finalCompletion);
        // Some provider adapters report function calls only in the terminal
        // completion rather than as separate stream events. Their reasoning may
        // likewise be terminal-only, so associate it before replaying calls.
        const toolCalls = [...streamedToolCalls];
        const hasTerminalReasoning = finalCompletion.output.some((item) => item.type === 'reasoning' && appendNativeReasoning(undefined, item) !== undefined);
        if (hasTerminalReasoning) {
            // Terminal output supplies native ordering and authoritative metadata.
            // Streamed fragments have already been displayed, but are not history.
            pendingNativeReasoning = undefined;
        }
        else {
            for (const reasoning of deferredNativeReasoning)
                commitPendingNativeReasoning(state, stream, queue, reasoning);
        }
        for (const item of finalCompletion.output) {
            if (item.type === 'reasoning') {
                // Each terminal native item is independently replayable; encrypted
                // reasoning cannot be concatenated or overwritten by its sibling.
                pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
                pendingNativeReasoning = appendNativeReasoning(undefined, item);
                continue;
            }
            if (item.type === 'tool_call') {
                pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
                if (!sawToolCall)
                    toolCalls.push(item);
                continue;
            }
            if (item.type !== 'provider_opaque')
                continue;
            pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
            const historyItem = {
                ...item.item,
                providerOpaque: {
                    provider: item.provider,
                    ...(item.sourceProvider ? { sourceProvider: item.sourceProvider } : {}),
                },
            };
            state.history.push(historyItem);
            state.input.push(item);
            if (isOpenAICompaction(item)) {
                // Completion usage describes the request before native replacement.
                // Retain billed usage/costs; invalidate only the next admission hint.
                state.lastCompletedInputTokens = undefined;
                state.inputUsageInvalidatedByCompaction = true;
            }
            outputPush(stream, queue, { type: 'item', item });
        }
        pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
        const assistantText = finalCompletion.output
            .filter((item) => item.type === 'message')
            .flatMap((item) => item.content)
            // Whitespace-only output (e.g. a background-notification acknowledgment)
            // must not enter the canonical history: the truthy check used to let
            // "\n\n" through, accumulating junk in model context.
            .map((part) => part.text)
            .filter((text) => text.length > 0)
            .join(ASSISTANT_TEXT_PART_SEPARATOR)
            .trim();
        if (assistantText) {
            stream.finalOutput = assistantText;
            const item = {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: assistantText }],
            };
            state.history.push(item);
            outputPush(stream, queue, { type: 'item', item });
            state.input.push({ type: 'message', role: 'assistant', content: [{ type: 'text', text: assistantText }] });
        }
        return toolCalls;
    }
    /** Execute and settle one tool plan; approvals suspend this operation in place. */
    async #executeTools(context, response, calls) {
        let { state, stream, queue, options, toolContext } = context;
        if (response.criticalWrapUp)
            return true;
        if (!state.criticalWrapUpPending && calls.length > 0) {
            await this.#dispatchToolCalls(state, stream, queue, calls, toolContext);
        }
        if (state.toolExecution.terminateAfterExecution)
            return true;
        if (calls.length === 0)
            return false;
        while (state.pendingRunBudgetInteraction || state.toolExecution.pendingApprovals.length > 0) {
            if (await this.#waitForBudget(context))
                return true;
            ({ state, stream, queue, options, toolContext } = context);
            let answeredApproval = false;
            if (state.toolExecution.pendingApprovals.length > 0) {
                stream.interruptions = state.toolExecution.pendingApprovals.map((item) => item.interruption);
                await this.#waitForDecision(context);
                ({ state, stream, queue, options, toolContext } = context);
                if (state.approvalQueue?.length) {
                    state.toolExecution.validateApprovalBatch(state.approvalQueue);
                    const batch = state.approvalQueue.splice(0);
                    for (const decision of batch)
                        state.toolExecution.resolveApproval({ callId: decision.callId, interruption: decision.interruption }, decision.decision, decision.message, state.approvals);
                    answeredApproval = true;
                }
                else if (state.approvalDecision) {
                    state.toolExecution.resolveApproval({ callId: state.approvalDecisionCallId, interruption: state.approvalDecisionInterruption }, state.approvalDecision, state.approvalMessage, state.approvals);
                    state.approvalDecision = undefined;
                    state.approvalDecisionCallId = undefined;
                    state.approvalDecisionInterruption = undefined;
                    state.approvalMessage = undefined;
                    answeredApproval = true;
                }
            }
            this.#assertLive(context);
            if (state.toolExecution.hasPlan) {
                await state.toolExecution.settle(this.#toolCallContext(state, stream, queue, toolContext));
            }
            stream.interruptions = state.toolExecution.pendingApprovals.map((item) => item.interruption);
            if (answeredApproval && options.stopAfterApprovalResolution && stream.interruptions.length === 0)
                return true;
            if (state.toolExecution.terminateAfterExecution)
                return true;
        }
        return false;
    }
    /** Normal no-tool completion; only an explicit stop-policy continuation repeats. */
    async #finishTurn(context) {
        const { state, options } = context;
        // The normal stop seam. A stop policy may keep the same run going; the
        // reminder is admitted at the next request boundary, where pending
        // budget evidence pauses first and turn accounting applies as usual.
        const stopDecision = options.onNormalStop && !options.signal?.aborted && !state.criticalWrapUpPending
            ? await options.onNormalStop(state.history, state.agent, context.requestAbortController.signal)
            : undefined;
        if (stopDecision) {
            this.#deps.logDiagnostic?.('Normal stop policy decided', { action: stopDecision.action, turnCount: state.turnCount, ...stopDecision.diagnostics }, { severity: 'debug', eventType: 'run_loop.normal_stop_policy' });
        }
        if (stopDecision?.action === 'continue') {
            if (stopDecision.repairDeadline !== undefined)
                state.completionRepairDeadline = stopDecision.repairDeadline;
            this.#queuePendingSystemNotice(stopDecision.reminder);
            return false;
        }
        if (stopDecision?.terminalCause)
            state.terminalCause = stopDecision.terminalCause;
        if (stopDecision?.action === 'stop' && stopDecision.notice) {
            this.#appendStopNotice(context, stopDecision.notice);
        }
        // Evidence discovered when a response has already completed needs no
        // human boundary: there is no later request or tool to block.
        state.pendingRunBudgetInteraction = undefined;
        return true;
    }
    async #dispatchToolCalls(state, stream, queue, events, toolContext) {
        const context = this.#toolCallContext(state, stream, queue, toolContext);
        await state.toolExecution.plan(events, context);
        stream.interruptions = state.toolExecution.pendingApprovals.map((item) => item.interruption);
        if (!state.pendingRunBudgetInteraction)
            await state.toolExecution.settle(context);
    }
    #toolCallContext(state, stream, queue, toolContext) {
        return {
            tools: state.agent.tools,
            approvals: state.approvals,
            toolContext,
            sessionId: state.sessionId,
            turnId: state.turnId,
            hookScope: state.hookScope,
            ...(state.requestSnapshot ? { requestSnapshot: state.requestSnapshot } : {}),
            onCall: (event) => {
                const callItem = {
                    type: event.toolType === 'custom' ? 'custom_tool_call' : 'function_call',
                    callId: event.id,
                    name: event.name,
                    ...(event.toolType === 'custom' ? { input: event.arguments } : { arguments: event.arguments }),
                    ...(event.providerMetadata ? { providerData: event.providerMetadata } : {}),
                };
                state.history.push(callItem);
                state.input.push({
                    type: 'tool_call',
                    id: event.id,
                    name: event.name,
                    arguments: event.arguments,
                    ...(event.toolType ? { toolType: event.toolType } : {}),
                    ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
                });
                outputPush(stream, queue, { type: 'item', item: callItem });
            },
            onExecutionStarted: (callId) => state.live?.session?.acceptToolDispatch(callId),
            ...(state.live?.session?.beforeToolDispatch
                ? {
                    beforeToolDispatch: async (callId) => {
                        await state.live?.session?.beforeToolDispatch?.(callId);
                        state.live?.options.signal?.throwIfAborted();
                    },
                }
                : {}),
            onDispatch: (entry) => {
                outputPush(stream, queue, {
                    type: 'tool_call_dispatched',
                    callId: entry.event.id,
                    toolName: entry.event.name,
                });
            },
            onToolStall: (input) => {
                const stallEvent = state.runBudget?.observeToolCall(input);
                if (stallEvent)
                    this.#emitRunBudgetEvent(state, stallEvent, 'Tool stall evidence', stream, queue);
            },
            onResult: (entry, result) => this.#appendToolResult(state, stream, queue, entry, result),
        };
    }
    #appendToolResult(state, stream, queue, entry, result) {
        const runCodeExecution = getRunCodeExecutionResult(result);
        const visibleResult = runCodeExecution ? (Array.isArray(result) ? result : String(result)) : result;
        const modelOutput = typeof visibleResult === 'string'
            ? visibleResult
            : isToolResultContentParts(visibleResult)
                ? visibleResult
                : JSON.stringify(visibleResult) ?? String(visibleResult ?? '');
        const resultItem = {
            type: entry.event.toolType === 'custom' ? 'custom_tool_call_output' : 'function_call_result',
            callId: entry.event.id,
            name: entry.event.name,
            output: modelOutput,
            ...(runCodeExecution ? { runCodeExecution: runCodeExecutionMetadata(runCodeExecution) } : {}),
        };
        state.history.push(resultItem);
        state.input.push({
            type: 'tool_result',
            id: entry.event.id,
            output: modelOutput,
            ...(runCodeExecution ? { runCodeExecution: runCodeExecutionMetadata(runCodeExecution) } : {}),
            ...(entry.event.toolType ? { toolType: entry.event.toolType } : {}),
        });
        outputPush(stream, queue, { type: 'item', item: resultItem });
        this.#evaluateRunBudget(state, stream, queue);
    }
    #nextRequestId() {
        nextCostRequestSeq += 1;
        return `req-${nextCostRequestSeq}`;
    }
    #appendCostRecord(state, input) {
        const record = computeModelCost({
            requestId: input.requestId,
            provider: input.provider ?? 'unknown',
            model: input.model,
            serviceTier: input.tier,
            outcome: input.outcome,
            usage: input.usage,
            providerUsd: input.providerUsd,
            getPrice: (provider, model, tier) => getModelPricing(provider, model, tier),
            pricingVersion: getCatalogPricingVersion(),
        });
        state.costRecords = [...(state.costRecords ?? []), record];
        return record;
    }
    #evaluateRunBudget(state, stream, queue) {
        if (!state.runBudget)
            return;
        for (const event of state.runBudget.evaluate({
            turns: state.turnCount,
            costRecords: state.costRecords ?? [],
        })) {
            this.#emitRunBudgetEvent(state, event, 'Run budget evidence', stream, queue);
        }
    }
    #emitRunBudgetEvent(state, event, message, stream, queue) {
        if (state.runBudgetEscalation === 'disabled') {
            return;
        }
        if (event.type === 'budget_stage' && event.stage === 'critical' && state.wrapUpOnCriticalRunBudget) {
            state.criticalWrapUpPending = true;
            state.terminalCause = 'budget_exhausted';
        }
        if (!state.wrapUpOnCriticalRunBudget &&
            !state.pendingRunBudgetInteraction &&
            (state.runBudgetEscalation === 'contain'
                ? event.type === 'budget_stage' && event.stage === 'critical'
                : state.runBudgetEscalation !== 'warn' && this.#requiresHumanBudgetDecision(event))) {
            state.pendingRunBudgetInteraction = { type: 'run_budget_interaction', event };
            state.runBudgetGrantConsumed = false;
        }
        if (stream && queue)
            outputPush(stream, queue, { type: 'run_budget', evidence: event });
        try {
            state.onRunBudgetEvent?.(event);
        }
        catch {
            // Evidence observers are delivery adapters, not budget owners.
            this.#deps.logDiagnostic?.('Run budget event observer failed', { type: event.type });
        }
        this.#deps.logDiagnostic?.(message, event);
    }
    #requiresHumanBudgetDecision(event) {
        return event.type === 'tool_stall' || (event.type === 'budget_stage' && event.stage !== 'soft');
    }
}
function isLunaChainedRequest(state, request) {
    return (state.currentProviderId === 'codex' &&
        state.agent.model === 'gpt-5.6-luna' &&
        typeof request.previousResponseId === 'string' &&
        request.previousResponseId.length > 0 &&
        request.input.length === 1 &&
        request.input[0]?.type === 'tool_result');
}
function getInterruptionCallId(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const callId = value.callId;
    return typeof callId === 'string' ? callId : undefined;
}
function outputPush(stream, queue, item) {
    stream.output.push(item);
    if (stream.newItems !== stream.output)
        stream.newItems.push(item);
    queue.push(item);
}
function finish(stream, state, queue) {
    stream.history = state.history;
    stream.historyReplacedByCompaction = state.compactedDuringRun === true;
    stream.terminalCause = state.terminalCause;
    stream.latestProviderInputTokens = state.lastCompletedInputTokens;
    if (state.supportsConversationChaining &&
        state.responseId &&
        state.responseProviderId !== undefined &&
        state.responseProviderId === state.currentProviderId) {
        stream.lastResponseId = state.responseId;
    }
    else {
        stream.lastResponseId = null;
    }
    queue.close();
    return { usage: state.usage, output: stream.output, costRecords: state.costRecords ?? [] };
}
/**
 * Only replay native reasoning when the provider explicitly supplies the
 * Chat-Completions continuation field. Generic reasoning remains display-only
 * so providers with different native formats are not given a foreign field.
 */
/**
 * True when any lane namespace in the metadata carries an `encrypted_content`
 * blob — the shape every Responses adapter produces, whichever vendor it is.
 */
function hasNamespacedEncryptedReasoning(metadata) {
    if (!metadata)
        return false;
    return Object.values(metadata).some((value) => asRecord(value)?.encrypted_content !== undefined);
}
function appendNativeReasoning(current, event) {
    const nativeReasoning = event.providerMetadata?.reasoning_content;
    if (typeof nativeReasoning === 'string') {
        const text = current?.text === nativeReasoning
            ? current.text
            : current?.text && nativeReasoning.startsWith(current.text)
                ? nativeReasoning
                : `${current?.text ?? ''}${nativeReasoning}`;
        return {
            ...(event.id ? { id: event.id } : current?.id ? { id: current.id } : {}),
            text,
            providerMetadata: { ...event.providerMetadata, reasoning_content: text },
        };
    }
    // Responses providers return encrypted reasoning only on their terminal
    // output. Their metadata is namespaced, so retain it without turning it into
    // the Chat-Completions-only reasoning_content convention. Match on the
    // namespaced shape rather than an allowlist of lane names: an allowlist
    // silently drops the reasoning of every Responses lane added later.
    if (hasNamespacedEncryptedReasoning(event.providerMetadata)) {
        return {
            ...(event.id ? { id: event.id } : current?.id ? { id: current.id } : {}),
            text: event.text,
            providerMetadata: event.providerMetadata,
        };
    }
    return current;
}
function commitPendingNativeReasoning(state, stream, queue, pending) {
    if (!pending)
        return undefined;
    const reasoningInput = {
        type: 'reasoning',
        ...(pending.id ? { id: pending.id } : {}),
        text: pending.text,
        providerMetadata: pending.providerMetadata,
    };
    const reasoningHistory = {
        type: 'reasoning',
        ...(pending.id ? { id: pending.id } : {}),
        content: [{ type: 'reasoning_text', text: pending.text }],
        providerData: pending.providerMetadata,
    };
    state.input.push(reasoningInput);
    state.history.push(reasoningHistory);
    outputPush(stream, queue, { type: 'item', item: reasoningHistory });
    return undefined;
}
/**
 * Resolve the effective billing service tier from the dispatched request. The
 * default service tier is standard; only a flex/batch request that was actually
 * dispatched resolves to its tier, and anything unrecognized fails closed.
 */
function resolveServiceTier(request) {
    const options = request.providerOptions;
    const raw = options?.service_tier ?? options?.serviceTier;
    if (raw === 'flex' || raw === 'batch' || raw === 'standard')
        return raw;
    return raw === undefined ? 'standard' : 'unknown';
}
function normalizeModelUsage(usage) {
    if (!usage || typeof usage !== 'object')
        return undefined;
    const rawUsage = usage;
    return normalizeUsage({
        ...rawUsage,
        cacheReadTokens: rawUsage.cachedInputTokens ?? rawUsage.cacheReadTokens,
        cacheCreationTokens: rawUsage.cacheWriteTokens ?? rawUsage.cacheCreationTokens,
        // AI SDK v3 `outputTokens.reasoning` (incl. OpenRouter) has no
        // snake_case twin in `normalizeUsage`; forward it explicitly so hidden
        // reasoning is subtracted from settled tok/s.
        reasoningTokens: rawUsage.outputTokens?.reasoning ?? rawUsage.reasoningTokens,
    });
}
/** The provider-facing tool catalog, shared by normal and prefix-preserving summary requests. */
export function toModelTools(tools) {
    return tools.map((tool) => tool.modelTool
        ? {
            type: tool.modelTool.type,
            name: tool.name,
            description: tool.description,
            format: tool.modelTool.format,
        }
        : {
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: isJsonSchema(tool.parameters) ? tool.parameters : z.toJSONSchema(tool.parameters),
        });
}
function isJsonSchema(value) {
    return typeof value === 'object' && value !== null && !isZodToolParameterSchema(value);
}
/**
 * The canonical application projection used for both model requests and
 * continuation-prefix comparisons. Keep this at the application boundary so
 * callers never need to inspect opaque continuation state.
 */
export function normalizeApplicationInput(input) {
    if (typeof input === 'string')
        return [{ type: 'message', role: 'user', content: [{ type: 'text', text: input }] }];
    const items = (Array.isArray(input) ? input : [input]);
    return items.flatMap((item) => normalizeInputItem(item));
}
function normalizeInput(input) {
    return normalizeApplicationInput(input);
}
function normalizeHistory(input) {
    if (typeof input === 'string')
        return [{ type: 'message', role: 'user', content: input }];
    return Array.isArray(input) ? [...input] : [input];
}
function mergeChainedCompactionHistory(sessionHistory, deltaHistory) {
    const firstDeltaItem = deltaHistory[0];
    const normalizedDelta = normalizeApplicationInput(deltaHistory);
    if (normalizedDelta[0]?.type === 'tool_result') {
        // A tool-only continuation needs a complete snapshot with still-open
        // producing calls. Normalize supported legacy/custom forms for comparison,
        // retain original provider items, and validate every later call/receipt.
        const pending = new Map();
        const seenCalls = new Set();
        for (const item of [...normalizeApplicationInput(sessionHistory), ...normalizedDelta]) {
            if (item.type === 'tool_call') {
                if (!item.id || seenCalls.has(item.id))
                    return { kind: 'skipped', reason: 'user_mismatch' };
                seenCalls.add(item.id);
                pending.set(item.id, item.toolType ?? 'function');
            }
            else if (item.type === 'tool_result') {
                if (!item.id || pending.get(item.id) !== (item.toolType ?? 'function'))
                    return { kind: 'skipped', reason: 'user_mismatch' };
                pending.delete(item.id);
            }
        }
        return { kind: 'ready', history: [...sessionHistory, ...deltaHistory] };
    }
    if (!firstDeltaItem || firstDeltaItem.type !== 'message' || firstDeltaItem.role !== 'user') {
        return { kind: 'skipped', reason: 'user_mismatch' };
    }
    let latestUserIndex = -1;
    for (let index = sessionHistory.length - 1; index >= 0; index--) {
        const item = sessionHistory[index];
        if (item.type === 'message' && item.role === 'user') {
            latestUserIndex = index;
            break;
        }
    }
    if (latestUserIndex < 0)
        return { kind: 'skipped', reason: 'user_mismatch' };
    const latestSessionUser = sessionHistory[latestUserIndex];
    const normalizedDeltaUser = normalizeApplicationInput([firstDeltaItem]);
    const normalizedSessionUser = normalizeApplicationInput([latestSessionUser]);
    if (JSON.stringify(normalizedDeltaUser) !== JSON.stringify(normalizedSessionUser)) {
        return { kind: 'skipped', reason: 'user_mismatch' };
    }
    return {
        kind: 'ready',
        history: [
            ...sessionHistory.slice(0, latestUserIndex),
            firstDeltaItem,
            ...sessionHistory.slice(latestUserIndex + 1),
            ...deltaHistory.slice(1),
        ],
    };
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
function unsupportedInput(description) {
    throw new Error(`Unsupported restored input ${description}`);
}
function normalizeTextPart(value, description) {
    if (typeof value === 'string')
        return { type: 'text', text: value };
    const record = asRecord(value);
    if (!record ||
        !['text', 'input_text', 'output_text'].includes(String(record.type)) ||
        typeof record.text !== 'string') {
        unsupportedInput(description);
    }
    return { type: 'text', text: record.text };
}
function normalizeMessageImage(record) {
    const image = record.image ?? record.image_url;
    const detail = typeof record.detail === 'string' ? record.detail : undefined;
    if (image === undefined)
        return { type: 'image', ...(detail ? { detail } : {}) };
    if (typeof image === 'string')
        return { type: 'image', image, ...(detail ? { detail } : {}) };
    const reference = asRecord(image);
    if (typeof reference?.id === 'string')
        return { type: 'image', image: { id: reference.id }, ...(detail ? { detail } : {}) };
    unsupportedInput('message image reference');
}
function normalizeMessagePart(value) {
    const record = asRecord(value);
    if (record?.type === 'image' || record?.type === 'input_image')
        return normalizeMessageImage(record);
    return normalizeTextPart(value, record?.type ? `message content: ${record.type}` : 'message content');
}
function normalizeMessageContent(value) {
    if (value === undefined || value === null)
        return [{ type: 'text', text: '' }];
    return (Array.isArray(value) ? value : [value]).map((part) => normalizeMessagePart(part));
}
function isTextMessagePart(part) {
    return part.type === 'text';
}
function normalizeToolImagePart(record) {
    const rawImage = record.image ?? record.image_url;
    const detail = typeof record.detail === 'string' ? record.detail : undefined;
    if (rawImage === undefined)
        return { type: 'image', ...(detail ? { detail } : {}) };
    if (typeof rawImage === 'string')
        return { type: 'image', image: rawImage, ...(detail ? { detail } : {}) };
    const image = asRecord(rawImage);
    if (!image)
        unsupportedInput('tool image reference');
    const normalized = typeof image.id === 'string'
        ? { id: image.id }
        : typeof image.url === 'string'
            ? { url: image.url }
            : typeof image.fileId === 'string'
                ? { fileId: image.fileId }
                : (typeof image.data === 'string' || image.data instanceof Uint8Array) && typeof image.mediaType === 'string'
                    ? { data: image.data, mediaType: image.mediaType }
                    : undefined;
    if (!normalized)
        unsupportedInput('tool image reference');
    return { type: 'image', image: normalized, ...(detail ? { detail } : {}) };
}
function normalizeToolFilePart(record) {
    const rawFile = record.file ?? record.file_id ?? record.file_url;
    const outerFilename = typeof record.filename === 'string' ? record.filename : undefined;
    if (typeof rawFile === 'string')
        return { type: 'file', file: rawFile };
    const file = asRecord(rawFile);
    if (!file)
        unsupportedInput('tool file reference');
    if (typeof file.id === 'string')
        return { type: 'file', file: { id: file.id, ...(outerFilename ? { filename: outerFilename } : {}) } };
    if (typeof file.url === 'string')
        return { type: 'file', file: { url: file.url, ...(outerFilename ? { filename: outerFilename } : {}) } };
    const filename = outerFilename ?? (typeof file.filename === 'string' ? file.filename : undefined);
    if ((typeof file.data === 'string' || file.data instanceof Uint8Array) &&
        typeof file.mediaType === 'string' &&
        filename !== undefined) {
        return { type: 'file', file: { data: file.data, mediaType: file.mediaType, filename } };
    }
    unsupportedInput('tool file reference');
}
function normalizeToolResultPart(value) {
    const record = asRecord(value);
    if (record?.type === 'image' || record?.type === 'input_image')
        return normalizeToolImagePart(record);
    if (record?.type === 'file' || record?.type === 'input_file')
        return normalizeToolFilePart(record);
    return normalizeTextPart(value, record?.type ? `tool result part: ${record.type}` : 'tool result part');
}
function normalizeToolResultOutput(value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined || value === null)
        return '';
    if (!Array.isArray(value))
        unsupportedInput('tool result output');
    return value.map(normalizeToolResultPart);
}
function normalizeReasoningText(value) {
    if (value === undefined || value === null)
        return '';
    if (typeof value === 'string')
        return value;
    const parts = Array.isArray(value) ? value : [value];
    return parts
        .map((part) => {
        const record = asRecord(part);
        if (!record ||
            !['reasoning_text', 'text', 'summary_text'].includes(String(record.type)) ||
            typeof record.text !== 'string') {
            return unsupportedInput('reasoning content part');
        }
        return record.text;
    })
        .join('');
}
/** True when the adapter marked this item as provider-native and opaque. */
function isProviderOpaque(item) {
    const marker = item.providerOpaque;
    return typeof marker?.provider === 'string' && marker.provider.length > 0;
}
function normalizeInputItem(item) {
    if (isProviderOpaque(item)) {
        const { providerOpaque: _marker, ...providerItem } = item;
        return [
            {
                type: 'provider_opaque',
                provider: item.providerOpaque.provider,
                ...(item.providerOpaque.sourceProvider ? { sourceProvider: item.providerOpaque.sourceProvider } : {}),
                item: providerItem,
            },
        ];
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        return [
            {
                type: 'tool_call',
                id: String(item.callId ?? item.call_id ?? ''),
                name: String(item.name ?? ''),
                arguments: String(item.type === 'custom_tool_call' ? item.input ?? '' : item.arguments ?? '{}'),
                ...(item.type === 'custom_tool_call' ? { toolType: 'custom' } : {}),
                ...(item.providerData ? { providerMetadata: item.providerData } : {}),
            },
        ];
    }
    if (item.type === 'function_call_result' ||
        item.type === 'function_call_output' ||
        item.type === 'custom_tool_call_output') {
        return [
            {
                type: 'tool_result',
                id: String(item.callId ?? item.call_id ?? item.tool_call_id ?? ''),
                output: normalizeToolResultOutput(item.output),
                ...(item.type === 'custom_tool_call_output' ? { toolType: 'custom' } : {}),
            },
        ];
    }
    if (item.type === 'reasoning') {
        const providerMetadata = item.providerData;
        return [
            {
                type: 'reasoning',
                ...(typeof item.id === 'string' ? { id: item.id } : {}),
                text: normalizeReasoningText(item.content ?? item.output ?? ''),
                ...(providerMetadata ? { providerMetadata } : {}),
            },
        ];
    }
    if (item.type !== undefined && item.type !== 'message')
        unsupportedInput(`item type: ${String(item.type)}`);
    const role = item.role === undefined
        ? 'user'
        : item.role === 'assistant' || item.role === 'system' || item.role === 'user'
            ? item.role
            : unsupportedInput(`message role: ${String(item.role)}`);
    const content = normalizeMessageContent(item.content);
    if (role === 'system') {
        const textContent = content.filter(isTextMessagePart);
        if (textContent.length !== content.length)
            unsupportedInput('system message content');
        return [{ type: 'message', role, content: textContent }];
    }
    return [{ type: 'message', role, content }];
}
/**
 * A legitimate but oversized tool call (usually one large edit) trips the
 * tool-argument caps. Unlike runaway output it is answerable: tell the model
 * the call never ran and let it split the work, a bounded number of times.
 */
const MAX_OVERSIZED_TOOL_ARGUMENT_RECOVERIES = 2;
function isOversizedToolArgumentTrip(error) {
    return (error instanceof GenerationGuardError &&
        (error.code === 'tool_argument_characters' || error.code === 'cumulative_tool_argument_characters'));
}
function oversizedToolArgumentNotice(guardMessage) {
    return (`Your previous response was discarded and its tool call was not executed. ${guardMessage} ` +
        'Redo the work in smaller tool calls, each well under that limit — for example, several targeted ' +
        'patches instead of rewriting a whole file in one call.');
}
//# sourceMappingURL=application-run-loop.js.map