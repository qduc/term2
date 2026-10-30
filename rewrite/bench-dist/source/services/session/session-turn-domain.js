import { TurnAttempt } from './turn-attempt.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import { ShellAutoApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import { isClassifiedCancellation } from '../retry/provider-failure-classification.js';
import { extractUsage } from '../../utils/ai/token-usage.js';
import { TurnProjectionState } from './turn-projection-state.js';
import { ToolApprovalBatchCoordinator } from '../approval/tool-approval-batch-coordinator.js';
import { createApprovalRequiredTerminal, buildConversationResult, } from '../conversation/conversation-result-builder.js';
import { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
import { extractFinalizationSnapshot } from '../stream-snapshot.js';
import { lastOpenAICompaction } from '../conversation/conversation-record-stream.js';
import { resolvePromptCacheKey, resolveSessionId } from './session-identity.js';
/** Session preparation, projection and decisions. The application runtime owns execution. */
export class SessionTurnDomain {
    deps;
    #activePolicyRegistry;
    #toolCallMarkers;
    #batchCoordinator;
    #hookTurnId;
    #compactionFailureNotified = false;
    #activeRecoveryBudget;
    #adoptedTurnActive;
    #attempt;
    #turnSignal;
    #input = '';
    #options = {};
    #state;
    #projection;
    #outcome = { kind: 'failed' };
    #emit = () => undefined;
    #policy;
    #decision;
    #assertAuthority() {
        if (!this.#adoptedTurnActive ||
            this.#turnSignal?.aborted ||
            (this.#attempt && !this.deps.generationGuard.isCurrent(this.#attempt.token))) {
            throw Object.assign(new Error('Turn authority is stale'), { name: 'AbortError' });
        }
    }
    #syncPolicyRegistry() {
        const current = this.deps.agentClient?.getApprovalPolicyRegistry?.();
        if (current && current !== this.#activePolicyRegistry) {
            this.#activePolicyRegistry = current;
            this.#batchCoordinator.updatePolicyRegistry(current);
        }
    }
    constructor(deps) {
        this.deps = deps;
        this.#activePolicyRegistry = deps.approvalPolicyRegistry;
        this.#toolCallMarkers = deps.toolCallMarkers ?? new ToolCallMarkerStore();
        this.#batchCoordinator =
            deps.batchCoordinator ??
                new ToolApprovalBatchCoordinator({
                    approvalFlow: deps.approvalFlow,
                    planApplier: deps.planApplier,
                    shellAutoApproval: deps.shellAutoApproval,
                    logger: deps.logger,
                    sessionId: deps.sessionId,
                    sessionAccess: deps.sessionAccess,
                    policyRegistry: deps.approvalPolicyRegistry,
                    isCurrent: (token) => deps.generationGuard.isCurrent(token),
                    hookLifecycle: deps.hookLifecycle,
                    hookEvents: deps.hookEvents,
                });
    }
    compactionFailureEvent(category) {
        if (this.#compactionFailureNotified)
            return undefined;
        this.#compactionFailureNotified = true;
        return {
            type: 'context_compaction_failed',
            provider: 'openai',
            sessionId: resolveSessionId(this.deps.sessionId),
            errorCategory: category,
            durationMs: 0,
        };
    }
    setHookTurnId(turnId) {
        this.#hookTurnId = turnId;
    }
    resetCompactionFailure() {
        this.#compactionFailureNotified = false;
    }
    /** The application runtime drives these callbacks; this object does not start a run. */
    #turnSession() {
        return {
            prepare: (signal) => this.#prepare(signal),
            beginSegment: () => this.deps.record.beginSegment(),
            acceptEvent: (event) => this.#acceptEvent(event),
            acceptToolDispatch: (callId) => this.deps.record.markDispatched(callId),
            acceptSegment: (stream) => this.#acceptSegment(stream),
            consume: (stream) => this.#consume(stream),
            interrupted: (stream) => this.#resolveInteraction(stream),
            completed: (stream) => this.#completed(stream),
            recover: (error) => this.#recover(error),
        };
    }
    /**
     * Bind the existing preparation, history and projection callbacks to an
     * externally driven application turn. The returned session never invokes
     * runTurn itself. Until interaction ownership is installed by the adopted
     * coordinator, an interrupted run fails closed rather than starting another
     * source loop.
     * @internal
     */
    beginAdoptedTurn(input, emit, options = {}, decide, postExecuteRunId) {
        if (this.#adoptedTurnActive)
            throw new Error('A conversation turn is already active');
        const authority = {};
        this.deps.setActivePostExecuteRunId?.(postExecuteRunId);
        this.#adoptedTurnActive = authority;
        this.#syncPolicyRegistry();
        this.#input = input;
        this.#options = options;
        this.#attempt = undefined;
        this.#state = undefined;
        this.#policy = undefined;
        this.#activeRecoveryBudget = undefined;
        this.#outcome = { kind: 'failed' };
        this.#emit = emit;
        this.#decision = decide;
        const callbacks = this.#turnSession();
        const assertCurrent = () => {
            if (this.#adoptedTurnActive !== authority)
                throw new Error('Adopted turn is stale');
            this.#assertAuthority();
        };
        return {
            postExecuteRunId,
            postExecuteTerminal: (entries) => {
                assertCurrent();
                return this.postExecuteApprovalTerminal(entries);
            },
            session: {
                ...callbacks,
                prepare: async (signal) => {
                    assertCurrent();
                    const result = await callbacks.prepare(signal);
                    assertCurrent();
                    return result;
                },
                beginSegment: (stream) => {
                    assertCurrent();
                    callbacks.beginSegment(stream);
                },
                acceptEvent: (event) => {
                    assertCurrent();
                    callbacks.acceptEvent(event);
                },
                acceptToolDispatch: (callId) => {
                    assertCurrent();
                    callbacks.acceptToolDispatch(callId);
                },
                acceptSegment: (stream) => {
                    assertCurrent();
                    callbacks.acceptSegment(stream);
                },
                consume: async (stream) => {
                    assertCurrent();
                    const result = await callbacks.consume(stream);
                    assertCurrent();
                    return result;
                },
                interrupted: async (stream) => {
                    assertCurrent();
                    const result = await callbacks.interrupted(stream);
                    assertCurrent();
                    return result;
                },
                completed: async (stream) => {
                    assertCurrent();
                    const result = await callbacks.completed(stream);
                    assertCurrent();
                    return result;
                },
                recover: async (error) => {
                    assertCurrent();
                    const result = await callbacks.recover(error);
                    assertCurrent();
                    return result;
                },
            },
            finish: () => {
                if (this.#adoptedTurnActive !== authority)
                    throw new Error('Adopted turn is stale');
                this.#adoptedTurnActive = undefined;
                this.deps.postExecutePending.closeRun(postExecuteRunId);
                this.deps.setActivePostExecuteRunId?.(null);
                this.#decision = undefined;
                this.#attempt?.close();
                this.#emit = () => undefined;
                return this.#outcome;
            },
        };
    }
    async #project(events, onEvent) {
        try {
            let next = await events.next();
            this.#assertAuthority();
            while (!next.done) {
                onEvent?.(next.value);
                this.#emit(next.value);
                next = await events.next();
                this.#assertAuthority();
            }
            return next.value;
        }
        finally {
            await events.return(undefined);
        }
    }
    async #prepare(signal) {
        this.#turnSignal = signal;
        if (!this.#attempt) {
            const created = this.#input instanceof TurnAttempt
                ? { kind: 'created', attempt: this.#input }
                : this.deps.attemptFactory.create(this.#input, {
                    ...this.#options,
                    signal: this.#options.signal ? AbortSignal.any([signal, this.#options.signal]) : signal,
                    recoveryBudget: this.#activeRecoveryBudget ?? this.#options.recoveryBudget,
                });
            if (created.kind === 'stale') {
                this.#outcome = { kind: 'stale' };
                return;
            }
            this.#attempt = created.attempt;
            this.#activeRecoveryBudget = this.#attempt.recoveryBudget;
            const counts = this.#attempt.retryCounts;
            if (this.#options.replayFromHistory ||
                !this.#options.skipUserMessage ||
                counts.modelRetryCount > 0 ||
                counts.serviceTierFallbackCount > 0 ||
                counts.transientRetryCount > 0 ||
                counts.transportDowngradeCount > 0) {
                this.deps.turnAccumulator.resetPersistedTurnState();
            }
            this.deps.record.beginTurn();
        }
        const attempt = this.#attempt;
        this.#state ??= new TurnProjectionState(attempt.token, attempt.recoveryBudget);
        this.#state.resetForAttempt(attempt.inputMode ?? 'delta');
        this.#policy = undefined;
        this.#projection = undefined;
        if (this.#options.delayMs)
            await this.#waitBeforeRetry(attempt, this.#options.delayMs);
        if (!this.deps.generationGuard.isCurrent(attempt.token)) {
            this.#outcome = { kind: 'stale' };
            return;
        }
        if (this.#options.useStandardServiceTier)
            this.deps.agentClient.useStandardServiceTierForNextRequest?.();
        const preparation = this.deps.inputPreparer.prepare(attempt, this.#options.skipUserMessage ?? false, this.#options);
        if (preparation.kind === 'blocked') {
            this.#emit(preparation.event);
            this.#outcome = { kind: 'failed' };
            return;
        }
        this.#state.inputMode = attempt.inputMode;
        return {
            input: attempt.streamInput,
            options: this.#initialOptions(attempt),
        };
    }
    #initialOptions(attempt) {
        const sessionId = resolveSessionId(this.deps.sessionId);
        const promptCacheKey = resolvePromptCacheKey(this.deps.sessionId);
        const options = {
            recoveryBudget: attempt.recoveryBudget,
            sessionId,
            ...(promptCacheKey !== sessionId ? { promptCacheKey } : {}),
            providerHistorySnapshot: attempt.providerHistorySnapshot,
            hookTurnId: this.#hookTurnId,
            ...(this.#options.disableChainingForAttempt ? { disableChainingForAttempt: true } : {}),
        };
        return this.deps.providerContinuity.prepareRequest(options, {
            kind: 'initial',
            inputMode: attempt.inputMode,
            disableChaining: this.#options.disableChainingForAttempt,
        });
    }
    #acceptEvent(event) {
        const state = this.#state;
        if (!state || !this.deps.generationGuard.isCurrent(state.token))
            return;
        if (event.type === 'text_delta')
            this.deps.record.recordTextDelta(event.text);
        if (event.type === 'reasoning_delta')
            this.deps.record.recordReasoningDelta(event.text);
        if (event.type === 'model_attempt_rollback')
            this.deps.record.rollbackReasoning(event.reasoningCharacters);
        if (event.type !== 'item')
            return;
        this.deps.record.acceptObservedItem(event.item);
        if (state.source === 'startStream')
            this.#attempt?.markModelEventSeen();
    }
    #acceptSegment(stream) {
        const state = this.#state;
        if (!this.deps.generationGuard.isCurrent(state.token))
            return;
        this.deps.record.acceptSegment(stream, state.inputMode, {
            logger: this.deps.logger,
            sessionId: this.deps.sessionId,
        });
    }
    /** Presentation only: no history acceptance or execution decision is produced here. */
    async #consume(stream) {
        const attempt = this.#attempt;
        attempt.attachStream(stream);
        const state = this.#state;
        await this.#project(this.#projectStream(state, stream));
    }
    async #completed(stream) {
        const state = this.#state;
        if (!this.deps.generationGuard.isCurrent(state.token)) {
            this.#outcome = { kind: 'stale' };
            return;
        }
        const outcome = await this.#buildResult(stream);
        this.#assertAuthority();
        if (outcome.kind !== 'response')
            throw new Error('Completed turn still requires a decision');
        this.#recordSuccess(state);
        this.#outcome = { kind: 'response', terminal: outcome.result };
    }
    async #waitForApproval(terminal) {
        if (!this.#decision)
            throw new Error('Turn interaction handling is not installed');
        return this.#decision(terminal, this.deps.approvalFlow.getPendingInterruption(), this.#turnSignal, this.#state.token);
    }
    async #applyDecision(init, policy) {
        const prepared = this.deps.planApplier.prepareInit(init);
        const state = this.#state;
        state.bindDecision(prepared);
        this.#policy = policy ?? new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval);
        await this.#project(this.deps.planApplier.applyInitialSetup(prepared));
    }
    async #resolveInteraction(stream) {
        const outcome = await this.#buildResult(stream);
        this.#assertAuthority();
        if (this.#state.source === 'startStream')
            this.#recordSuccess(this.#state);
        if (!outcome || outcome.kind === 'response')
            throw new Error('Expected an interrupted stream');
        let init;
        const state = this.#state;
        if (state.source === 'startStream') {
            if (outcome.kind === 'auto_approve') {
                if (outcome.advisory?.source === 'llm')
                    this.#toolCallMarkers.markToolCallAsLlmAutoApproved(outcome.callId);
                init = this.deps.approvalFlow.buildApprovalDecision('y');
                await this.#applyDecision(init);
            }
            else {
                this.deps.planApplier.recordPendingApproval(outcome.result.approval);
                await this.#emitApprovalRequested(outcome.result.approval);
                const answer = await this.#waitForApproval(outcome.result);
                this.#assertAuthority();
                init = answer.init;
                await this.#applyDecision(init, answer.policy);
            }
        }
        else {
            const result = await this.#handleApprovalOutcome(outcome, state, this.#policy, state.cumulativeUsage);
            this.#assertAuthority();
            if (result.action === 'loop') {
                await this.#project(this.deps.planApplier.applyNextPlan(result.nextPlan, state, result.isApproved));
            }
            else {
                if (result.result.kind !== 'approval_required')
                    throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
                const answer = await this.#waitForApproval(result.result.terminal);
                this.#assertAuthority();
                init = answer.init;
                await this.#applyDecision(init, answer.policy);
            }
        }
        const stopAfterResolution = await this.#resolveBatch(init?.kind === 'approval_decision' && init.stopAfterApprovalResolution === true);
        return this.#continuationOptions(stopAfterResolution);
    }
    async #resolveBatch(stopAfterResolution) {
        const result = await this.#project(this.#stagePendingParallelApprovals(this.#state, this.#policy));
        this.#assertAuthority();
        if (result.kind === 'stale')
            throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
        if (result.kind === 'approval_required') {
            const answer = await this.#waitForApproval(result.terminal);
            this.#assertAuthority();
            await this.#applyDecision(answer.init, answer.policy);
            return this.#resolveBatch(stopAfterResolution ||
                (answer.init.kind === 'approval_decision' && answer.init.stopAfterApprovalResolution === true));
        }
        return stopAfterResolution;
    }
    #continuationOptions(stopAfterApprovalResolution) {
        const state = this.#state;
        const sessionId = resolveSessionId(this.deps.sessionId);
        const promptCacheKey = resolvePromptCacheKey(this.deps.sessionId);
        const options = {
            recoveryBudget: state.recoveryBudget,
            sessionId,
            ...(promptCacheKey !== sessionId ? { promptCacheKey } : {}),
            providerHistorySnapshot: this.deps.record.getProviderHistorySnapshot(),
            hookTurnId: this.#hookTurnId,
            ...(stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
        };
        return this.deps.providerContinuity.prepareRequest(options, { kind: 'continuation' });
    }
    async #recover(error) {
        if (isClassifiedCancellation(error))
            throw error;
        if (!this.#state || this.#state.source === 'startStream') {
            const handled = await this.#project(this.deps.recoveryHandler.handle({ error, attempt: this.#attempt, stream: this.#attempt?.stream ?? null }));
            if (handled.kind === 'run') {
                this.#options = {
                    ...this.#options,
                    ...handled.instruction,
                    delayMs: handled.delayMs,
                    useStandardServiceTier: handled.useStandardServiceTier,
                    disableChainingForAttempt: handled.instruction.disableChainingForAttempt === true,
                };
                return true;
            }
            if (handled.kind === 'stale') {
                this.#outcome = { kind: 'stale' };
                return false;
            }
            throw error;
        }
        const recovered = await this.#project(this.deps.continuationRecoveryHandler.handle({ error, state: this.#state }));
        this.#assertAuthority();
        if (recovered.kind === 'stale') {
            this.#outcome = { kind: 'stale' };
            return false;
        }
        if (recovered.kind === 'terminated')
            throw error;
        const token = this.#state.token;
        this.#attempt?.close();
        this.#attempt = undefined;
        this.#input = { text: '' };
        this.#options = {
            skipUserMessage: true,
            token,
            retries: recovered.retryCounts,
            delayMs: recovered.delayMs,
            useStandardServiceTier: recovered.useStandardServiceTier,
            disableChainingForAttempt: recovered.disableChainingForAttempt,
            replayFromHistory: true,
            recoveryBudget: this.#activeRecoveryBudget,
        };
        this.#syncPolicyRegistry();
        return true;
    }
    #contextCompactionCompletedEvent(args) {
        const compaction = lastOpenAICompaction(extractFinalizationSnapshot(args.stream).output);
        if (!compaction)
            return [];
        return [
            {
                type: 'context_compaction_completed',
                provider: compaction.provider,
                sessionId: resolveSessionId(this.deps.sessionId),
                ...(args.inputTokensBefore !== undefined ? { inputTokensBefore: args.inputTokensBefore } : {}),
                // The provider reports no post-compaction size: usage.input_tokens is the
                // compaction pass's own input, i.e. the pre-compaction total.
                inputTokensAfter: undefined,
                durationMs: args.durationMs ?? 0,
            },
        ];
    }
    postExecuteApprovalTerminal(entries) {
        const entry = entries[0];
        const snapshot = this.deps.postExecutePending.snapshot();
        return createApprovalRequiredTerminal({
            agentName: 'Agent',
            toolName: entry.toolName,
            argumentsText: entry.argumentsText,
            deniedRead: entry.deniedRead,
            rawInterruption: { type: 'post_execute', runId: entry.runId, id: entry.id },
            callId: entry.toolCallId,
            postExecute: {
                kind: 'post_execute',
                sessionId: snapshot.sessionId,
                epoch: snapshot.epoch,
                revision: snapshot.revision,
                ids: [entry.id],
            },
        });
    }
    async #waitBeforeRetry(attempt, delayMs) {
        const signal = this.#turnSignal && attempt.signal
            ? AbortSignal.any([this.#turnSignal, attempt.signal])
            : this.#turnSignal ?? attempt.signal;
        if (signal?.aborted)
            throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
        if (!signal) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return;
        }
        await new Promise((resolve, reject) => {
            const onAbort = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                reject(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, delayMs);
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }
    async *#stagePendingParallelApprovals(state, activePolicy) {
        const result = yield* this.#batchCoordinator.stageBatch({
            state,
            policy: activePolicy,
            token: state.token,
        });
        if (result.kind === 'stale') {
            return { kind: 'stale' };
        }
        return result;
    }
    async #handleApprovalOutcome(outcome, state, activePolicy, nextCumulativeUsage, previousInputForSurge) {
        const { kind } = outcome;
        if (kind === 'auto_approve') {
            if (outcome.advisory?.source === 'llm') {
                this.#toolCallMarkers.markToolCallAsLlmAutoApproved(outcome.callId);
            }
            this.deps.logger.debug('Shell command auto-approved by LLM', {
                eventType: 'approval.auto_approved',
                category: 'approval',
                phase: 'approval',
                sessionId: resolveSessionId(this.deps.sessionId),
                traceId: this.deps.logger.getCorrelationId(),
                callId: outcome.callId,
                command: outcome.argumentsText,
                model: outcome.advisory?.model,
                reasoning: outcome.advisory?.reasoning,
            });
            const nextPlan = this.deps.approvalFlow.prepareContinuation('y', undefined, 'policy');
            if (!nextPlan) {
                const approvalFallback = this.#createApprovalRequiredFromAutoApprove(outcome, nextCumulativeUsage);
                return { action: 'return', result: { kind: 'approval_required', terminal: approvalFallback } };
            }
            return { action: 'loop', nextPlan, isApproved: true };
        }
        const approvalContext = {
            toolName: outcome.result.approval.toolName,
            argumentsText: outcome.result.approval.argumentsText,
            callId: outcome.result.approval.callId,
            llmAdvisory: outcome.result.approval.llmAdvisory,
        };
        const decision = await activePolicy.decide(approvalContext);
        this.#assertAuthority();
        if (decision === 'prompt') {
            this.deps.planApplier.recordPendingApproval(approvalContext);
            if (outcome.result.approval.callId) {
                this.deps.logger.debug('Tool approval required', {
                    eventType: 'approval.required',
                    category: 'approval',
                    phase: 'approval',
                    sessionId: resolveSessionId(this.deps.sessionId),
                    traceId: this.deps.logger.getCorrelationId(),
                    toolName: outcome.result.approval.toolName,
                });
            }
            this.#recordSuccess(state, previousInputForSurge);
            const resultWithUsage = {
                ...outcome.result,
                ...(nextCumulativeUsage && Object.keys(nextCumulativeUsage).length > 0 ? { usage: nextCumulativeUsage } : {}),
            };
            return { action: 'return', result: { kind: 'approval_required', terminal: resultWithUsage } };
        }
        if (decision === 'approve') {
            this.deps.logger.debug('Shell command auto-approved by policy', {
                eventType: 'approval.auto_approved',
                category: 'approval',
                phase: 'approval',
                sessionId: resolveSessionId(this.deps.sessionId),
                traceId: this.deps.logger.getCorrelationId(),
                callId: approvalContext.callId,
                command: approvalContext.argumentsText,
            });
        }
        const answer = decision === 'approve' ? 'y' : 'n';
        const nextPlan = this.deps.approvalFlow.prepareContinuation(answer, undefined, decision === 'approve' || decision === 'reject' ? 'policy' : 'user');
        if (!nextPlan) {
            return { action: 'return', result: { kind: 'approval_required', terminal: outcome.result } };
        }
        return { action: 'loop', nextPlan, isApproved: answer === 'y' };
    }
    /** Every stream segment projects through this path into the same turn state. */
    async *#projectStream(state, stream) {
        state.setLastStream(stream);
        const previousIds = state.previouslyEmittedIds;
        const acc = yield* this.deps.streamProcessor.process(stream, {
            gen: state.token,
            source: state.source,
            preserveExistingToolArgs: state.source !== 'startStream',
            previouslyEmittedCommandIds: previousIds,
        });
        if (!this.deps.generationGuard.isCurrent(state.token))
            return;
        yield* this.#contextCompactionCompletedEvent({
            stream,
            inputTokensBefore: acc.latestUsage?.prompt_tokens,
            durationMs: acc.lastContextCompactionDurationMs,
        });
        state.previouslyEmittedIds = new Set([...previousIds, ...acc.emittedCommandIds]);
        state.setCumulativeUsage(acc.latestUsage ?? state.cumulativeUsage ?? extractUsage(stream));
        this.#projection = acc;
    }
    /** Called by the execution owner at a decision/completion boundary, never by projection. */
    async #buildResult(stream) {
        const state = this.#state;
        const acc = this.#projection;
        if (state.source === 'startStream') {
            this.#attempt.advanceRetry({ ...this.#attempt.retryCounts, transientRetryCount: 0 });
        }
        else
            state.setRetryCounts({ ...state.retryCounts, transientRetryCount: 0 });
        return await buildConversationResult({
            result: stream,
            finalOutputOverride: acc?.finalOutput || undefined,
            reasoningOutputOverride: acc?.reasoningOutput || undefined,
            emittedCommandIds: state.previouslyEmittedIds,
            usage: acc?.latestUsage,
            toolCallArgumentsById: this.deps.toolTracker.snapshotArguments(),
            turnItems: this.deps.turnAccumulator.getTurnItems(),
            token: state.token,
            inputMode: state.inputMode,
        }, {
            approvalFlow: this.deps.approvalFlow,
            shellAutoApproval: this.deps.shellAutoApproval,
            logger: this.deps.logger,
            sessionId: resolveSessionId(this.deps.sessionId),
            sessionAccess: this.deps.sessionAccess,
            approvalPolicyRegistry: this.#activePolicyRegistry,
            toolCallMarkers: this.#toolCallMarkers,
            assertCurrent: () => this.#assertAuthority(),
        });
    }
    #recordSuccess(state, previousInputForSurge) {
        const previousInput = state.source === 'startStream' ? this.#attempt.streamInput : previousInputForSurge;
        const input = state.source === 'startStream' ? this.#attempt.streamInput : state.lastStream;
        this.deps.inputPlanner.recordSuccess(state.inputMode === 'delta' ? input : this.deps.record.getHistory(), state.inputMode === 'delta' ? { kind: state.inputMode } : { kind: state.inputMode, previousInput });
    }
    #createApprovalRequiredFromAutoApprove(outcome, usage) {
        const pending = this.deps.approvalFlow.getPending();
        if (pending) {
            const { toolName, argumentsText } = getToolInfoFromInterruption(pending.interruption);
            const agent = pending.interruption && typeof pending.interruption === 'object'
                ? pending.interruption.agent
                : undefined;
            const agentName = agent && typeof agent === 'object' ? agent.name : 'Agent';
            const callId = getCallIdFromObject(pending.interruption);
            return createApprovalRequiredTerminal({
                agentName: typeof agentName === 'string' ? agentName : 'Agent',
                toolName: toolName ?? 'Unknown Tool',
                argumentsText,
                rawInterruption: pending.interruption,
                callId: callId ? String(callId) : undefined,
                llmAdvisory: outcome.advisory,
                usage,
            });
        }
        return createApprovalRequiredTerminal({
            agentName: 'Agent',
            toolName: 'Unknown Tool',
            argumentsText: outcome.argumentsText,
            rawInterruption: undefined,
            callId: outcome.callId,
            llmAdvisory: outcome.advisory,
            usage,
        });
    }
    async #emitApprovalRequested(approval) {
        if (!this.deps.hookLifecycle || !this.deps.hookEvents)
            return;
        let normalizedArguments = approval.argumentsText;
        try {
            normalizedArguments = JSON.parse(approval.argumentsText);
        }
        catch {
            // Preserve a bounded opaque representation for malformed model input.
        }
        await this.deps.hookLifecycle.emit(this.deps.hookEvents.create('approval.requested', {
            toolName: approval.toolName,
            normalizedArguments: this.deps.hookEvents.includeToolArguments
                ? normalizedArguments
                : typeof normalizedArguments === 'string'
                    ? normalizedArguments.slice(0, 500)
                    : JSON.stringify(normalizedArguments).slice(0, 500),
            approvalKind: approval.toolName === 'ask_user' ? 'ask_user' : 'tool',
            proposedDecision: 'approve',
        }, { toolCallId: approval.callId }));
    }
}
//# sourceMappingURL=session-turn-domain.js.map