import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AgentClient } from '../../../../source/lib/agent-client.js';
import { isHarnessInvariantError } from '../../../../source/lib/harness-invariant-error.js';
import { waitForAbortableRead } from '../../../../source/contracts/abort-aware-wait.js';
import { ApplicationRunLoop, } from '../../../../source/services/agent-runtime/application-run-loop.js';
export { createAdoptedToolContext, createRunNested } from './nested.js';
import { convertSourceItems } from './conversion.js';
import { isAdoptedSettingsPair } from '../../config/adopted/settings.js';
/** A failed durability boundary must never be retried as a provider or tool failure. */
export class FatalPersistenceError extends Error {
    code = 'fatal_persistence';
    constructor(cause) {
        super('Persistence failed', { cause });
        this.name = 'FatalPersistenceError';
    }
}
export class InvalidAdoptedInputError extends Error {
    constructor() {
        super('Turn input does not match the current source agent');
        this.name = 'InvalidAdoptedInputError';
    }
}
export const isFatalPersistenceError = (error) => error instanceof FatalPersistenceError;
class Queue {
    abandon;
    values = [];
    wake;
    ended = false;
    suspended = false;
    constructor(abandon) {
        this.abandon = abandon;
    }
    push(value) {
        if (!this.ended) {
            if (value.type === 'turn_ended' && value.outcome.kind === 'suspended')
                this.suspended = true;
            this.values.push(value);
            this.wake?.();
        }
    }
    end() {
        this.ended = true;
        this.wake?.();
    }
    async *[Symbol.asyncIterator]() {
        let finished = false;
        try {
            while (true) {
                if (this.values.length) {
                    yield this.values.shift();
                    continue;
                }
                if (this.ended) {
                    finished = true;
                    return;
                }
                await new Promise((resolve) => {
                    this.wake = resolve;
                });
                this.wake = undefined;
            }
        }
        finally {
            if (!finished && !this.suspended)
                this.abandon();
        }
    }
}
const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
async function waitForGate(operation, signal) {
    void operation.catch(() => undefined);
    if (signal.aborted)
        throw aborted();
    let onAbort;
    try {
        await Promise.race([
            operation,
            new Promise((_resolve, reject) => {
                onAbort = () => reject(aborted());
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted)
                    onAbort();
            }),
        ]);
    }
    finally {
        if (onAbort)
            signal.removeEventListener('abort', onAbort);
    }
}
const same = (a, b) => isDeepStrictEqual(a, b);
const grants = new Set([
    'allow-once',
    'allow-remember',
    'unsandboxed-once',
    'allow-folder-session',
    'allow-edit-file-session',
    'allow-edit-folder-session',
    'docker-allow-once',
    'docker-allow-session',
    'docker-allow-project',
]);
function validDecision(value) {
    if (!value || typeof value !== 'object')
        return false;
    const fields = Object.keys(value);
    if ('stopAfterApprovalResolution' in value && typeof value.stopAfterApprovalResolution !== 'boolean')
        return false;
    const allowed = value.kind === 'approve'
        ? ['kind']
        : value.kind === 'reject'
            ? ['kind', 'reason']
            : value.kind === 'answer'
                ? ['kind', 'answer']
                : value.kind === 'grant'
                    ? ['kind', 'grant']
                    : [];
    if (!allowed.length || fields.some((field) => field !== 'stopAfterApprovalResolution' && !allowed.includes(field)))
        return false;
    if (value.kind === 'reject' && value.reason !== undefined && typeof value.reason !== 'string')
        return false;
    if (value.kind === 'answer' && typeof value.answer !== 'string')
        return false;
    if (value.kind === 'grant' && !grants.has(value.grant))
        return false;
    return true;
}
const failure = (message) => ({
    type: 'turn_ended',
    outcome: { kind: 'failed', error: { kind: 'invalid_request', message, retryable: false } },
});
/** Adapter lifecycle over the real application client. Binding of its dependencies is supplied by the adopted composition. */
export function createAdoptedEngine(options) {
    const { deps } = options;
    if (!isAdoptedSettingsPair(deps.settings, options.clientOptions.deps.settings) ||
        deps.models.settingsService !== options.clientOptions.deps.settings) {
        throw new Error('Adopted engine requires one paired scoped settings service');
    }
    let selectedInput;
    let initialAgent;
    const client = new AgentClient({
        ...options.clientOptions,
        assembleAgent: options.assembleAgent,
        validateApplicationAgent: (agent, providerId) => {
            if (!selectedInput)
                throw new Error('No adopted turn is active');
            const logical = active.get(selectedInput.turnId);
            if (!logical || logical.modelCalls === 0) {
                options.validateTurnInput(selectedInput, agent, providerId);
                initialAgent = [agent, providerId];
            }
        },
        modelBinding: {
            hasUnsettledReads: () => deps.models.hasUnsettledReads(),
            trackDetachedRead: (operation) => deps.models.trackDetachedRead(operation),
            providerDefinition: (providerId) => deps.models.providerDefinition(providerId),
            scopedModel: (ref, modelDeps) => deps.models.createScoped(ref, modelDeps).original,
            acquireHelper: (ref, modelDeps) => deps.models.acquireHelper(ref, modelDeps),
            fetchModels: (providerId, modelDeps) => deps.models.fetchScopedModels(providerId, modelDeps),
            modelDefaultReasoningLevel: (providerId, modelId, settings) => deps.models.modelDefaultReasoningLevel(providerId, modelId, settings),
            providerDefaultReasoningLevel: (providerId) => deps.models.providerDefaultReasoningLevel(providerId),
        },
        selectApplicationAgent: (agent) => {
            if (!selectedInput)
                throw new Error('No adopted turn is active');
            let tools;
            try {
                tools = deps.tools.originals(selectedInput.toolNames);
            }
            catch {
                throw new InvalidAdoptedInputError();
            }
            if (tools.some((tool) => !agent.tools.includes(tool)))
                throw new InvalidAdoptedInputError();
            return { ...agent, tools: [...tools] };
        },
        adoptedProviderBinding: {
            provider: (providerId) => deps.models.providerDefinition(providerId),
            model: (provider, model) => deps.models.original({ provider, model }).original,
            independentModel: (provider, model) => deps.models.createIndependent({ provider, model }).original,
        },
        driverFactory: (dependencies) => {
            if (deps.models.hasUnsettledReads())
                throw new Error('A prior adopted model read has not settled');
            return new ApplicationRunLoop({
                ...dependencies,
                abortPendingModelReads: true,
                recordBudgetStopCause: true,
                onDetachedModelRead: (operation) => deps.models.trackDetachedRead(operation),
            });
        },
    });
    const bridges = new Map();
    const active = new Map();
    const parked = new Map();
    const detachCompactionObserver = client.addLocalCheckpointObserver((evidence) => {
        const logical = selectedInput && active.get(selectedInput.turnId);
        if (logical && !logical.controller.signal.aborted)
            logical.compactions.push({ checkpoint: evidence.checkpoint, replaced: evidence.replaced, index: evidence.index });
    });
    let disposed = false;
    const disposalController = new AbortController();
    const cancel = (logical) => {
        if (logical.controller.signal.aborted || active.get(logical.input.turnId) !== logical)
            return;
        logical.controller.abort();
        if (logical.parked) {
            const entry = logical.parked;
            parked.delete(entry.checkpoint.checkpointId);
            logical.parked = undefined;
            entry.reject(aborted());
        }
        client.abort();
    };
    const queue = (logical) => new Queue(() => {
        if (!logical.suspended && !logical.finished)
            cancel(logical);
    });
    const view = (logical) => ({
        turnId: logical.input.turnId,
        events: logical.queue,
        cancel: () => cancel(logical),
        waitForSettlement: (signal) => (signal ? waitForAbortableRead(logical.settled, signal) : logical.settled),
    });
    const invalid = (turnId, message) => {
        const q = new Queue(() => { });
        q.push(failure(message));
        q.end();
        return {
            turnId,
            events: q,
            cancel() { },
            waitForSettlement: (signal) => (signal?.aborted ? Promise.reject(aborted()) : Promise.resolve()),
        };
    };
    const engine = {
        async waitForAdmission(signal) {
            const combined = AbortSignal.any([signal, disposalController.signal]);
            while (true) {
                combined.throwIfAborted();
                const runs = [...active.values()];
                if (runs.length)
                    await waitForAbortableRead(Promise.allSettled(runs.map((run) => run.settled)).then(() => undefined), combined);
                await deps.models.waitForReadSettlement(combined);
                combined.throwIfAborted();
                if (!active.size && !deps.models.hasUnsettledReads())
                    return;
            }
        },
        registerTurnBridge(turnId, authority, create) {
            if (disposed || bridges.has(turnId) || active.has(turnId))
                throw new Error('Turn bridge already registered or engine disposed');
            const registration = { authority, create };
            bridges.set(turnId, registration);
            return () => {
                if (bridges.get(turnId) === registration && !active.has(turnId))
                    bridges.delete(turnId);
            };
        },
        start(input) {
            try {
                const snapshot = JSON.parse(JSON.stringify(input));
                if (!same(snapshot, input))
                    return invalid(input.turnId, 'Turn input is not serializable');
                input = snapshot;
            }
            catch {
                return invalid(input.turnId, 'Turn input is not serializable');
            }
            const registration = bridges.get(input.turnId);
            if (deps.models.hasUnsettledReads())
                return invalid(input.turnId, 'adopted_model_read_busy');
            if (disposed ||
                !registration ||
                !registration.authority.isCurrent() ||
                active.size > 0 ||
                input.budget.kind !== 'adopted')
                return invalid(input.turnId, 'Missing or invalid adopted turn bridge');
            try {
                if (new Set(input.toolNames).size !== input.toolNames.length)
                    throw new Error('Duplicate offered tool');
                deps.tools.originals(input.toolNames);
            }
            catch {
                return invalid(input.turnId, 'Configured tool is missing from the adopted registry');
            }
            const logical = {
                input,
                controller: new AbortController(),
                produced: [],
                segment: '',
                suspended: false,
                calls: [],
                modelCalls: 0,
                compactions: [],
                answers: new Map(),
                resolving: false,
                stopAfterApprovalResolution: false,
            };
            logical.queue = queue(logical);
            active.set(input.turnId, logical);
            const control = {
                signal: logical.controller.signal,
                publishSessionEvent(event) {
                    if (active.get(input.turnId) !== logical ||
                        logical.controller.signal.aborted ||
                        !registration.authority.isCurrent())
                        return;
                    if (event.type !== 'retry')
                        return;
                    const kind = event.errorKind && event.errorKind !== 'unknown' ? event.errorKind : 'provider';
                    logical.queue.push({
                        type: 'retrying',
                        attempt: event.attempt,
                        delayMs: event.delayMs ?? 0,
                        error: {
                            kind,
                            message: event.errorMessage,
                            retryable: true,
                            ...(event.retryAfterMs !== undefined ? { retryAfterMs: event.retryAfterMs } : {}),
                        },
                    });
                },
                steer: (items, options) => active.get(input.turnId) === logical &&
                    registration.authority.isCurrent() &&
                    !logical.controller.signal.aborted
                    ? client.steer(items, options)
                    : Promise.resolve('released'),
                retractSteer: (id) => active.get(input.turnId) === logical &&
                    registration.authority.isCurrent() &&
                    !logical.controller.signal.aborted
                    ? client.retractSteer(id)
                    : false,
                editSteer: (id, items) => active.get(input.turnId) === logical &&
                    registration.authority.isCurrent() &&
                    !logical.controller.signal.aborted
                    ? client.editSteer(id, items)
                    : false,
                setAskUserAnswer: (callId, answer) => {
                    if (!logical.resolving ||
                        active.get(input.turnId) !== logical ||
                        logical.controller.signal.aborted ||
                        !registration.authority.isCurrent() ||
                        logical.answers.get(callId) !== answer)
                        throw new Error('Ask-user answer is stale or does not match the decision');
                    logical.answers.delete(callId);
                    client.setAskUserAnswer(callId, answer);
                },
                park(request) {
                    if (disposed ||
                        active.get(input.turnId) !== logical ||
                        logical.finished ||
                        logical.controller.signal.aborted ||
                        request.generation !== registration.authority.generation ||
                        request.isCurrent !== registration.authority.isCurrent ||
                        !request.isCurrent() ||
                        logical.parked)
                        return Promise.reject(aborted());
                    if (new Set(request.approvals.map((approval) => approval.callId)).size !== request.approvals.length ||
                        request.approvals.some((approval) => {
                            const call = request.pendingCalls.find((candidate) => candidate.callId === approval.callId && candidate.toolName === approval.toolName);
                            if (!call)
                                return true;
                            return !approval.agentId && !logical.calls.some((observed) => same(observed, call));
                        }))
                        return Promise.reject(new InvalidAdoptedInputError());
                    try {
                        request.validatePendingSnapshot(request.pendingCalls);
                    }
                    catch {
                        return Promise.reject(new InvalidAdoptedInputError());
                    }
                    const checkpointId = randomUUID();
                    const checkpoint = {
                        turnId: input.turnId,
                        checkpointId,
                        input,
                        produced: [...logical.produced],
                        pendingCalls: request.pendingCalls,
                        modelCalls: logical.modelCalls,
                        continuation: { kind: 'adopted_live', version: 1, checkpointId },
                    };
                    let snapshot;
                    let approvals;
                    try {
                        snapshot = JSON.parse(JSON.stringify(checkpoint));
                        approvals = JSON.parse(JSON.stringify(request.approvals));
                        if (!same(checkpoint, snapshot) || !same(request.approvals, approvals))
                            throw new Error('Non-serializable checkpoint');
                    }
                    catch {
                        return Promise.reject(new InvalidAdoptedInputError());
                    }
                    return new Promise((resolve, reject) => {
                        const entry = {
                            checkpoint: snapshot,
                            generation: request.generation,
                            decisionAddress: request.decisionAddress,
                            current: request.isCurrent,
                            approvals,
                            validate: request.validate,
                            resolve,
                            reject,
                            logical,
                        };
                        logical.parked = entry;
                        logical.current = request.isCurrent;
                        parked.set(checkpointId, entry);
                        logical.suspended = true;
                        const published = JSON.parse(JSON.stringify(snapshot));
                        logical.queue.push({ type: 'checkpoint', checkpoint: published });
                        logical.queue.push({
                            type: 'turn_ended',
                            outcome: {
                                kind: 'suspended',
                                approvals: JSON.parse(JSON.stringify(approvals)),
                                checkpoint: JSON.parse(JSON.stringify(snapshot)),
                            },
                        });
                        logical.queue.end();
                    });
                },
            };
            let bridge;
            try {
                bridge = registration.create(control);
                if (typeof bridge.getAcceptedHistory !== 'function')
                    throw new Error('Missing accepted history capability');
            }
            catch (error) {
                active.delete(input.turnId);
                return invalid(input.turnId, String(error));
            }
            const emit = (event) => {
                switch (event.type) {
                    case 'text_delta':
                        logical.queue.push({ type: 'text_delta', delta: event.text });
                        break;
                    case 'reasoning_delta':
                        logical.queue.push({ type: 'reasoning_delta', delta: event.text });
                        break;
                    case 'model_attempt_rollback':
                        logical.queue.push({ type: 'model_attempt_rollback', reasoningCharacters: event.reasoningCharacters });
                        break;
                    case 'tool_call_dispatched': {
                        const call = logical.calls.find((candidate) => candidate.callId === event.callId && candidate.toolName === event.toolName);
                        logical.queue.push({
                            type: 'tool_started',
                            callId: event.callId,
                            toolName: event.toolName,
                            input: call?.input,
                        });
                        break;
                    }
                    case 'usage_update':
                        logical.queue.push({
                            type: 'usage',
                            usage: {
                                inputTokens: event.usage.prompt_tokens ?? 0,
                                outputTokens: event.usage.completion_tokens ?? 0,
                                cachedInputTokens: event.usage.cache_read_tokens ?? 0,
                            },
                        });
                        break;
                    case 'item': {
                        const source = event.item;
                        if ((source.type === 'function_call' || source.type === 'custom_tool_call') &&
                            typeof source.callId === 'string' &&
                            typeof source.name === 'string') {
                            const raw = source.type === 'custom_tool_call' ? source.input : source.arguments;
                            logical.calls.push({
                                callId: source.callId,
                                toolName: source.name,
                                input: raw,
                            });
                        }
                        if ((source.type === 'function_call_result' || source.type === 'custom_tool_call_output') &&
                            typeof source.callId === 'string') {
                            const index = logical.calls.findIndex((call) => call.callId === source.callId);
                            if (index >= 0)
                                logical.calls.splice(index, 1);
                            logical.queue.push({
                                type: 'tool_finished',
                                callId: source.callId,
                                result: {
                                    output: typeof source.output === 'string' ? source.output : JSON.stringify(source.output) ?? '',
                                    isError: source.isError === true,
                                },
                            });
                        }
                        for (const converted of convertSourceItems([source], input.model.provider)) {
                            logical.produced.push(converted);
                            logical.queue.push({ type: 'item', item: converted });
                        }
                        break;
                    }
                }
            };
            const wrapped = {
                approvalBatch: true,
                abortPendingModelReads: true,
                recordBudgetStopCause: true,
                onDetachedModelRead: (operation) => deps.models.trackDetachedRead(operation),
                async prepare(signal) {
                    if (!registration.authority.isCurrent()) {
                        cancel(logical);
                        throw aborted();
                    }
                    const result = await bridge.prepare(signal);
                    if (!registration.authority.isCurrent()) {
                        cancel(logical);
                        throw aborted();
                    }
                    return result;
                },
                beginSegment(stream) {
                    if (!registration.authority.isCurrent() || logical.controller.signal.aborted) {
                        cancel(logical);
                        throw aborted();
                    }
                    bridge.beginSegment(stream);
                    logical.segment = randomUUID();
                    logical.queue.push({ type: 'segment_started', segmentId: logical.segment });
                },
                acceptEvent(event) {
                    if (!registration.authority.isCurrent() || logical.controller.signal.aborted) {
                        cancel(logical);
                        throw aborted();
                    }
                    bridge.acceptEvent(event);
                    emit(event);
                },
                onModelDispatch(event) {
                    if (!registration.authority.isCurrent()) {
                        cancel(logical);
                        throw aborted();
                    }
                    if (logical.modelCalls === 0 && initialAgent)
                        options.validateTurnInput(input, ...initialAgent);
                    bridge.onModelDispatch?.(event);
                    logical.modelCalls++;
                },
                acceptToolDispatch(callId) {
                    if (!registration.authority.isCurrent() || logical.controller.signal.aborted) {
                        cancel(logical);
                        throw aborted();
                    }
                    bridge.acceptToolDispatch(callId);
                    logical.queue.push({ type: 'tool_dispatched', callId: callId });
                },
                async beforeToolDispatch(callId) {
                    logical.controller.signal.throwIfAborted();
                    if (!registration.authority.isCurrent()) {
                        cancel(logical);
                        throw aborted();
                    }
                    if (logical.current && !logical.current())
                        throw aborted();
                    if (bridge.beforeToolDispatch) {
                        try {
                            await waitForGate(Promise.resolve().then(() => bridge.beforeToolDispatch(callId)), logical.controller.signal);
                        }
                        catch (error) {
                            if (logical.controller.signal.aborted)
                                throw aborted();
                            const fatal = isFatalPersistenceError(error) ? error : new FatalPersistenceError(error);
                            logical.failure = fatal;
                            cancel(logical);
                            throw fatal;
                        }
                    }
                    logical.controller.signal.throwIfAborted();
                    if (!registration.authority.isCurrent()) {
                        cancel(logical);
                        throw aborted();
                    }
                    if (logical.current && !logical.current())
                        throw aborted();
                },
                isFatalError: (error) => isFatalPersistenceError(error) || error instanceof InvalidAdoptedInputError || isHarnessInvariantError(error),
                acceptSegment(stream) {
                    if (!registration.authority.isCurrent() || logical.controller.signal.aborted) {
                        cancel(logical);
                        throw aborted();
                    }
                    bridge.acceptSegment(stream);
                    if (!registration.authority.isCurrent()) {
                        cancel(logical);
                        throw aborted();
                    }
                    const sourceHistory = bridge.getAcceptedHistory();
                    const nativeCompaction = bridge.getAcceptedCompaction?.();
                    if (nativeCompaction)
                        logical.compactions.push(nativeCompaction);
                    const history = [];
                    const compactions = [];
                    const matched = new Set();
                    for (const [index, sourceItem] of sourceHistory.entries()) {
                        const converted = convertSourceItems([sourceItem], input.model.provider);
                        const evidence = logical.compactions.find((candidate) => !matched.has(candidate) &&
                            same(candidate.checkpoint, sourceItem) &&
                            logical.compactions.filter((other) => same(other.checkpoint, sourceItem)).length === 1 &&
                            (candidate.index === index ||
                                sourceHistory.filter((item) => same(candidate.checkpoint, item)).length === 1));
                        if (evidence && converted.length === 1) {
                            matched.add(evidence);
                            compactions.push({ summaryId: converted[0].id, replaced: evidence.replaced });
                        }
                        history.push(...converted);
                    }
                    logical.compactions = logical.compactions.filter((candidate) => !matched.has(candidate));
                    logical.queue.push({
                        type: 'segment_committed',
                        segmentId: logical.segment,
                        history,
                    });
                    for (const evidence of compactions)
                        logical.queue.push({ type: 'compacted', ...evidence });
                },
                consume: (stream) => bridge.consume(stream),
                async interrupted(stream) {
                    try {
                        const options = await bridge.interrupted(stream);
                        return logical.stopAfterApprovalResolution ? { ...options, stopAfterApprovalResolution: true } : options;
                    }
                    finally {
                        logical.resolving = false;
                        logical.answers.clear();
                    }
                },
                async completed(stream) {
                    if (!registration.authority.isCurrent() || logical.controller.signal.aborted) {
                        cancel(logical);
                        throw aborted();
                    }
                    await bridge.completed(stream);
                    if (!registration.authority.isCurrent() || logical.controller.signal.aborted) {
                        cancel(logical);
                        throw aborted();
                    }
                    logical.finished = true;
                    logical.queue.push({
                        type: 'turn_ended',
                        outcome: stream.cancelled
                            ? { kind: 'cancelled' }
                            : stream.terminalCause === 'budget_exhausted'
                                ? { kind: 'budget_exhausted' }
                                : stream.terminalCause
                                    ? { kind: 'failed', error: { kind: 'provider', message: stream.terminalCause, retryable: false } }
                                    : { kind: 'completed' },
                    });
                },
                async recover(error) {
                    const retry = await bridge.recover(error);
                    if (retry)
                        logical.compactions = [];
                    if (!retry)
                        logical.failure = error;
                    return retry;
                },
            };
            client.openTurn();
            selectedInput = input;
            logical.settled = client
                .runTurn(wrapped)
                .catch((error) => {
                logical.failure ??= error;
            })
                .finally(() => {
                if (!logical.finished)
                    logical.queue.push(logical.controller.signal.aborted && !isFatalPersistenceError(logical.failure)
                        ? { type: 'turn_ended', outcome: { kind: 'cancelled' } }
                        : logical.failure instanceof InvalidAdoptedInputError
                            ? failure(logical.failure.message)
                            : {
                                type: 'turn_ended',
                                outcome: { kind: 'failed', error: { kind: 'provider', message: 'Turn failed', retryable: false } },
                            });
                logical.queue.end();
                client.closeTurn();
                selectedInput = undefined;
                initialAgent = undefined;
                active.delete(input.turnId);
                bridges.delete(input.turnId);
            });
            return view(logical);
        },
        resume(checkpoint, decisions) {
            const entry = checkpoint.checkpointId && parked.get(checkpoint.checkpointId);
            if (!entry)
                return invalid(checkpoint.turnId, 'checkpoint_unavailable');
            const registration = bridges.get(entry.logical.input.turnId);
            if (!registration ||
                registration.authority.generation !== entry.generation ||
                !same(checkpoint, entry.checkpoint) ||
                !entry.current() ||
                entry.logical.controller.signal.aborted)
                return invalid(checkpoint.turnId, 'Invalid checkpoint');
            const ids = new Set(entry.approvals.map((a) => a.callId));
            if (decisions.size !== ids.size ||
                [...decisions].some(([id, decision]) => !ids.has(id) ||
                    !validDecision(decision) ||
                    (decision.kind === 'answer' &&
                        !entry.approvals.some((approval) => approval.callId === id && approval.toolName === 'ask_user'))))
                return invalid(checkpoint.turnId, 'Invalid decision batch');
            try {
                entry.validate(decisions);
            }
            catch {
                return invalid(checkpoint.turnId, 'Invalid decision batch');
            }
            for (const approval of entry.approvals) {
                const decision = decisions.get(approval.callId);
                if (decision?.stopAfterApprovalResolution)
                    entry.logical.stopAfterApprovalResolution = true;
                if (!approval.agentId && approval.toolName === 'ask_user' && decision?.kind === 'answer')
                    entry.logical.answers.set(approval.callId, decision.answer);
            }
            parked.delete(checkpoint.checkpointId);
            entry.logical.parked = undefined;
            entry.logical.suspended = false;
            entry.logical.resolving = true;
            entry.logical.queue = queue(entry.logical);
            entry.resolve(new Map([...decisions].map(([id, decision]) => [id, { ...decision }])));
            return view(entry.logical);
        },
        async dispose() {
            disposed = true;
            disposalController.abort();
            const runs = [...active.values()];
            for (const run of runs)
                cancel(run);
            await Promise.allSettled(runs.map((run) => run.settled));
            bridges.clear();
            detachCompactionObserver();
            client.dispose();
        },
    };
    try {
        const result = options.bindSessionClient?.(client);
        if (result != null &&
            (typeof result === 'object' || typeof result === 'function') &&
            typeof result.then === 'function') {
            void Promise.resolve(result).catch(() => { });
            throw new TypeError('bindSessionClient must be synchronous');
        }
    }
    catch (error) {
        try {
            detachCompactionObserver();
        }
        catch {
            /* Preserve the binding error. */
        }
        try {
            client.dispose();
        }
        catch {
            /* Preserve the binding error. */
        }
        throw error;
    }
    return engine;
}
//# sourceMappingURL=index.js.map