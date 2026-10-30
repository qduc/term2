import { waitForAbortableRead } from '../contracts/abort-aware-wait.js';
import { createLegacyNestedRunDriver } from '../services/agent-runtime/legacy-nested-driver.js';
import { isProviderContextOverflow, ProviderContextOverflowError, } from '../services/agent-runtime/request-input-limit.js';
import { resolveModelContextPolicy, resolveRequestOutput } from '../services/agent-runtime/model-context-policy.js';
import { normalizeApplicationInput, toModelTools, } from '../services/agent-runtime/application-run-loop.js';
import { readRunBudgetPolicy } from '../services/agent-runtime/run-budget.js';
import { AskUserAnswerStore } from './ask-user-answer-store.js';
import { AgentConfiguration } from './agent-configuration.js';
import { SubagentBridge } from './subagent-bridge.js';
import { ToolInterceptorRegistry } from './tool-interceptor-registry.js';
import { AgentChatService, AgentChatFailure } from './agent-chat-service.js';
import { ShellChildRegistry } from '../utils/shell/shell-child-registry.js';
import { getProvider } from '../providers/index.js';
import { ApplicationRunLoop } from '../services/agent-runtime/application-run-loop.js';
import { createGoalStopPolicy } from '../services/conversation/durable-goal-stop-check.js';
import { createVerifiedGoalStopPolicy } from '../services/completion-verification/goal-stop-policy.js';
import { RootCompletionBoundary } from '../services/completion-verification/root-boundary.js';
import { randomUUID } from 'node:crypto';
import { fetchModels } from '../services/model-service.js';
import { prepareOpenAIRequestPrefixBinding, runWithOpenAIRequestPrefixBindingScope, } from '../providers/openai-request-prefix-binding.js';
import { isDeepStrictEqual } from 'node:util';
import { MIN_CHECK_IN_INTERVAL_SECONDS, MIN_NEXT_CHECK_IN_SECONDS } from '../tools/agent/configure-task-check-in.js';
import { ContextCompactionHardFitError, LocalContextCompactor, } from '../services/agent-runtime/context-compaction/local-context-compactor.js';
import { CONTEXT_COMPACTION_INSTRUCTIONS } from '../prompts/context-compaction.js';
import { getCatalogModel } from '../providers/model-catalog/catalog.js';
import { supportsContextCompactionModel } from '../providers/openai-responses-model.js';
import { isCodexCompactionIncompatible } from '../providers/codex-compact.js';
import { estimateContext, rearmAtTokens, shouldDeferAutomaticCompaction, } from '../services/agent-runtime/context-compaction/index.js';
import { projectConversationMessage } from '../services/conversation/conversation-message-projection.js';
import { isLocalContextSummary } from '../contracts/provider-input.js';
import { classifyProviderFailure } from '../services/retry/provider-failure-classification.js';
import { ContextMilestoneReminder } from '../services/agent-runtime/context-compaction/context-milestone-reminder.js';
import { createOpenRouterDecisionClient } from '../services/decision-shadow/decision-client.js';
import { DecisionShadowPilot } from '../services/decision-shadow/decision-shadow-pilot.js';
function findConversationResetModel(model) {
    const visited = new Set();
    let current = model;
    while (current && typeof current === 'object' && !visited.has(current)) {
        visited.add(current);
        const wrapped = current.wrappedModel;
        if (wrapped && typeof wrapped === 'object' && typeof wrapped.stream === 'function') {
            current = wrapped;
            continue;
        }
        return typeof current.resetConversationState === 'function' ? current : undefined;
    }
    return undefined;
}
function createScopedToolLifecycle(lifecycle, scope) {
    const withScope = (context) => ({
        ...context,
        scope: { subagent: scope },
    });
    return {
        before: (context) => lifecycle.before(withScope(context)),
        after: (context, result, duration) => lifecycle.after(withScope(context), result, duration),
        error: (context, error, duration, convertedToModelResult) => lifecycle.error(withScope(context), error, duration, convertedToModelResult),
    };
}
export class AgentClient {
    #agentConfig;
    #shellChildRegistry = new ShellChildRegistry();
    #toolInterceptorRegistry;
    #applicationRunLoop;
    #contextCompactionSessionState = { disabled: false };
    #unavailableCodexCompaction = new WeakSet();
    #maxTurns;
    #retryAttempts;
    #retryCallback = null;
    #currentCorrelationId = null;
    #activeStartController = null;
    #chatService;
    #logger;
    #settings;
    #onGoalAchieved;
    #completionBoundary;
    #unattended = false;
    #sessionContextService;
    #requestCapture;
    #providerRegistry;
    #modelBinding;
    #adoptedProviderBinding;
    #selectApplicationAgent;
    #validateApplicationAgent;
    #subagentBridge = null;
    #askUserAnswerStore;
    #isDisposed = false;
    #toolLifecycle;
    #localCheckpointSink;
    #localCheckpointObservers = new Set();
    #hookScope = 'root';
    #backgroundShellRegistry;
    #backgroundShellOutput;
    #backgroundCheckInScheduler;
    #wrapUpOnCriticalRunBudget = false;
    // Cache application streamed models, which may own session-scoped transport
    // state (notably ResponsesWS), until the provider configuration changes.
    #streamedModelCache = new Map();
    #contextMilestoneReminder = new ContextMilestoneReminder();
    #sessionRolloverRequest = null;
    #lastCompletedProviderInputTokens;
    #blockedCompactionRearmAtEstimatedTokens;
    #blockedCompactionUserTurnCount;
    #lastLogicalSessionId;
    #lastPromptCacheKey;
    #clearStreamedModelCache() {
        for (const cached of this.#streamedModelCache.values()) {
            if (cached.ownership !== 'owned')
                continue;
            void Promise.resolve(cached.model)
                .then((model) => model.close?.())
                .catch(() => undefined);
        }
        this.#streamedModelCache.clear();
    }
    #discardStreamedModel(cacheKey, cached) {
        if (this.#streamedModelCache.get(cacheKey) !== cached)
            return;
        this.#streamedModelCache.delete(cacheKey);
        if (cached.ownership !== 'owned')
            return;
        void Promise.resolve(cached.model)
            .then((model) => model.close?.())
            .catch(() => undefined);
    }
    #resolveStreamedModel(selectedModel) {
        const providerId = this.#agentConfig.getProvider();
        if (this.#adoptedProviderBinding)
            return this.#adoptedProviderBinding.model(providerId, selectedModel);
        const provider = getProvider(providerId, this.#providerRegistry);
        if (!provider?.createStreamedModel) {
            throw new Error(`Provider '${providerId}' does not expose an application streamed model.`);
        }
        const cacheKey = `${providerId}\u0000${selectedModel}`;
        const cached = this.#streamedModelCache.get(cacheKey);
        if (cached)
            return cached.model;
        const model = provider.createStreamedModel(selectedModel, {
            settingsService: this.#settings,
            loggingService: this.#logger,
            sessionContextService: this.#sessionContextService,
            onRetry: (info) => this.#retryCallback?.(info),
            retryAttempts: this.#retryAttempts,
            requestCapture: this.#requestCapture,
            contextCompactionSessionState: this.#contextCompactionSessionState,
        });
        const entry = {
            model,
            // Transient subagent clients may receive session-shared models from a
            // provider. They own only this cache entry, not the model's transport.
            ownership: this.#agentConfig.isTransientClient ? 'borrowed' : 'owned',
        };
        this.#streamedModelCache.set(cacheKey, entry);
        if (model instanceof Promise) {
            void model.catch(() => {
                if (this.#streamedModelCache.get(cacheKey) === entry)
                    this.#streamedModelCache.delete(cacheKey);
            });
        }
        return model;
    }
    async #compactCodexHistory(input) {
        const catalog = getCatalogModel('codex', input.model);
        const inputCeiling = this.#settings.get('agent.maxRequestInputTokens');
        const policy = resolveModelContextPolicy({
            contextWindow: catalog?.contextWindow,
            maxOutputTokens: resolveRequestOutput(catalog, this.#agentConfig.getApplicationAgent().modelSettings?.maxTokens),
            inputLimit: inputCeiling,
            ratio: this.#settings.get('agent.contextCompaction.compactThreshold') ?? 0.8,
            rawTrigger: this.#settings.get('agent.contextCompaction.compactThresholdTokens'),
        });
        const threshold = { available: policy.softTrigger !== undefined, effectiveThreshold: policy.softTrigger ?? 0 };
        const estimate = estimateContext({
            history: input.history,
            instructions: input.instructions,
            tools: input.tools,
            contextWindow: catalog?.contextWindow,
            maxOutputTokens: resolveRequestOutput(catalog, this.#agentConfig.getApplicationAgent().modelSettings?.maxTokens),
        });
        const measuredInputTokens = Math.max(input.lastCompletedInputTokens ?? 0, estimate.renderedInputTokens);
        if (!input.manual) {
            // Native replacement has no portable growth checkpoint. Preserve its
            // existing one-successful-replacement-per-run policy; local checkpoints rearm by growth.
            if (input.automaticCompactionsThisRun >= 1)
                return { kind: 'unchanged' };
            if (!threshold.available || measuredInputTokens < threshold.effectiveThreshold) {
                this.#logger.debug('Codex native compaction threshold not reached', {
                    model: input.model,
                    measuredInputTokens,
                    estimatedInputTokens: estimate.renderedInputTokens,
                    effectiveThreshold: threshold.available ? threshold.effectiveThreshold : undefined,
                });
                return { kind: 'unchanged' };
            }
            const deferred = shouldDeferAutomaticCompaction({
                automaticCompactionsThisRun: input.automaticCompactionsThisRun,
                renderedInputTokens: measuredInputTokens,
                hasCompleteNewUserTurn: true,
            });
            if (deferred)
                return { kind: 'unchanged' };
        }
        const streamed = await this.#resolveStreamedModel(input.model);
        if (!input.manual && this.#unavailableCodexCompaction.has(streamed)) {
            return { kind: 'unchanged', nativeUnavailable: true };
        }
        if (!streamed.compactHistory) {
            this.#logger.warn('Codex compact endpoint is unavailable; continuing with uncompacted history', {
                model: input.model,
            });
            return { kind: 'unchanged', nativeUnavailable: true };
        }
        input.onStarted('codex');
        try {
            const compacted = await streamed.compactHistory({
                input: normalizeApplicationInput(input.history),
                signal: input.signal,
            });
            const history = compacted.history;
            if (history.length === 0) {
                throw new Error('Codex compact endpoint returned an empty history');
            }
            this.#unavailableCodexCompaction.delete(streamed);
            return { kind: 'compacted', history, modelInput: history };
        }
        catch (error) {
            if (input.signal?.aborted)
                throw error;
            if (isProviderContextOverflow(error))
                throw new ProviderContextOverflowError(error);
            const nativeUnavailable = isCodexCompactionIncompatible(error);
            if (nativeUnavailable)
                this.#unavailableCodexCompaction.add(streamed);
            this.#logger.warn('Codex compact endpoint failed; continuing with uncompacted history', {
                eventType: 'context_compaction.native_failed',
                model: input.model,
                error: error instanceof Error ? error.message : String(error),
                automaticRetry: nativeUnavailable ? 'disabled_for_model_instance' : 'eligible',
                recovery: nativeUnavailable ? 'Manual /compact retries; auto mode can use local compaction.' : 'unchanged',
            });
            return { kind: 'failed', provider: 'codex', nativeUnavailable };
        }
    }
    /**
     * Freeze the live request envelope for both manual and automatic compaction.
     * Summary transport history is isolated from the root while cache affinity
     * stays rooted in the same session, including across logical rollover.
     */
    createContextSummaryGenerator(sessionId, promptCacheKey, instructions) {
        const context = this.#sessionContextService.getContext();
        const id = sessionId ?? context?.sessionId ?? this.#lastLogicalSessionId;
        const cacheKey = promptCacheKey ?? context?.promptCacheKey ?? this.#lastPromptCacheKey ?? id;
        const isRoot = !this.#agentConfig.isTransientClient && context?.providerHistoryKey === undefined && !context?.evaluator;
        const historyKey = context?.providerHistoryKey ?? id;
        const configured = this.#agentConfig.getApplicationAgent(id, cacheKey);
        const agent = {
            ...configured,
            instructions: instructions ?? configured.resolveInstructionsForRequest?.() ?? configured.instructions,
        };
        const provider = this.#agentConfig.getProvider();
        const model = this.#agentConfig.getModel();
        const summaryContext = id
            ? {
                ...context,
                sessionId: id,
                sessionStartedAt: context?.sessionStartedAt ?? new Date().toISOString(),
                promptCacheKey: cacheKey,
            }
            : undefined;
        return {
            requestContext: { instructions: agent.instructions, tools: toModelTools(agent.tools) },
            generate: async ({ history, renderedInput, maxOutputTokens, signal }) => {
                const helperHistoryKey = `${historyKey}:context-summary:${crypto.randomUUID()}`;
                const generate = () => history
                    ? this.#chatService.summarizeHistory(history, renderedInput, agent, provider, maxOutputTokens, signal)
                    : this.#chatService.chatDetailed(renderedInput, {
                        provider,
                        model,
                        reasoningEffort: this.#settings.get('agent.reasoningEffort'),
                        instructions: CONTEXT_COMPACTION_INSTRUCTIONS,
                        maxTokens: maxOutputTokens,
                        signal,
                    });
                let result;
                try {
                    result = await (summaryContext
                        ? this.#sessionContextService.runWithContext({
                            ...summaryContext,
                            // Never reuse helper chain state, including between serialized
                            // fallback chunks. Only the raw-prefix path benefits from root
                            // socket affinity, and it runs exclusively at a root boundary.
                            providerHistoryKey: helperHistoryKey,
                            rootContextCompaction: history && isRoot ? true : undefined,
                        }, generate)
                        : generate());
                }
                finally {
                    if (summaryContext)
                        await this.#chatService.releaseSummaryHistory(provider, model, helperHistoryKey);
                }
                return {
                    text: result.text,
                    usage: result.usage
                        ? { inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens }
                        : undefined,
                    costRecords: result.costRecords,
                };
            },
        };
    }
    #boundaryCompaction() {
        const enabled = this.#settings.get('agent.contextCompaction.enabled');
        if (!enabled)
            return undefined;
        return {
            compact: async ({ history, instructions, tools, recordCostRecords, automaticCompactionsThisRun, lastCompletedInputTokens, signal, onStarted, }) => {
                const mode = this.#settings.get('agent.contextCompaction.mode') ?? 'native';
                const provider = this.#agentConfig.getProvider();
                const model = this.#agentConfig.getModel();
                const catalog = getCatalogModel(provider, model);
                const openaiInlineNative = (this.#adoptedProviderBinding ? this.#adoptedProviderBinding.provider(provider) : getProvider(provider))
                    ?.capabilities?.supportsContextCompaction === true &&
                    supportsContextCompactionModel(model) &&
                    !this.#contextCompactionSessionState.disabled;
                if (provider === 'codex' && mode !== 'local') {
                    const native = await this.#compactCodexHistory({
                        history,
                        instructions,
                        tools,
                        model,
                        automaticCompactionsThisRun,
                        lastCompletedInputTokens,
                        signal,
                        onStarted,
                        manual: false,
                    });
                    if (mode !== 'auto' || !('nativeUnavailable' in native && native.nativeUnavailable))
                        return native;
                    // Auto was explicitly selected. Keep the existing local safe-cut and
                    // opaque-history checks; a rejected native call never discards history.
                }
                const inputCeiling = this.#settings.get('agent.maxRequestInputTokens');
                const boundaryEstimate = estimateContext({ history, instructions, tools });
                // Inline native compaction owns its opaque state. Its trigger is bounded
                // by admission in auto mode; never replace ciphertext with a guessed summary.
                if (mode === 'native' || (mode === 'auto' && openaiInlineNative))
                    return { kind: 'unchanged' };
                const configuredMaxOutput = resolveRequestOutput(catalog, this.#agentConfig.getApplicationAgent().modelSettings?.maxTokens);
                let started = false;
                const generator = this.createContextSummaryGenerator(undefined, undefined, instructions);
                const compactor = new LocalContextCompactor({
                    requestContext: generator.requestContext,
                    generate: async (request) => {
                        if (!started) {
                            started = true;
                            onStarted(provider);
                        }
                        let result;
                        try {
                            result = await generator.generate(request);
                        }
                        catch (error) {
                            if (error instanceof AgentChatFailure && error.costRecords.length)
                                recordCostRecords?.(error.costRecords);
                            throw error;
                        }
                        if (result.costRecords?.length && recordCostRecords && !recordCostRecords(result.costRecords))
                            throw new Error('Run budget exhausted while reducing context; original history retained.');
                        return result;
                    },
                });
                const checkpoint = history.find(isLocalContextSummary)?.contextSummary;
                const genuineUserTurns = history.filter((item) => {
                    const message = projectConversationMessage(item);
                    return message?.role === 'user' && !message.isSynthetic;
                }).length;
                const checkpointIndex = history.findIndex(isLocalContextSummary);
                const hasCompleteNewUserTurn = this.#blockedCompactionUserTurnCount !== undefined
                    ? genuineUserTurns > this.#blockedCompactionUserTurnCount
                    : checkpointIndex >= 0
                        ? history.slice(checkpointIndex + 1).some((item) => {
                            const message = projectConversationMessage(item);
                            return message?.role === 'user' && !message.isSynthetic;
                        })
                        : true;
                let outcome;
                try {
                    outcome = await compactor.compactAtBoundary({
                        history,
                        instructions,
                        tools,
                        maxRequestInputTokens: inputCeiling,
                        provider,
                        model,
                        sourceRevision: 0,
                        contextWindow: catalog?.contextWindow,
                        maxOutputTokens: configuredMaxOutput,
                        compactThreshold: this.#settings.get('agent.contextCompaction.compactThreshold') ?? 0.8,
                        compactThresholdTokens: this.#settings.get('agent.contextCompaction.compactThresholdTokens') ?? null,
                        manual: false,
                        automaticCompactionsThisRun,
                        hasCompleteNewUserTurn,
                        checkpoint: checkpoint ? { rearmAtEstimatedTokens: checkpoint.rearmAtEstimatedTokens } : undefined,
                        rearmAtEstimatedTokens: this.#blockedCompactionRearmAtEstimatedTokens,
                        lastCompletedInputTokens,
                        signal,
                    });
                }
                catch (error) {
                    if (signal?.aborted)
                        throw error;
                    if (isProviderContextOverflow(error))
                        throw new ProviderContextOverflowError(error);
                    this.#blockedCompactionRearmAtEstimatedTokens = rearmAtTokens(boundaryEstimate.renderedInputTokens, inputCeiling ?? catalog?.contextWindow ?? 64_000);
                    this.#logger.warn('Automatic local context compaction failed; continuing with uncompacted history', {
                        provider,
                        model,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return started ? { kind: 'failed', provider } : { kind: 'unchanged' };
                }
                if (outcome.kind === 'blocked' &&
                    (outcome.reason === 'single_turn_too_large' || outcome.reason === 'result_still_too_large')) {
                    return {
                        kind: 'failed',
                        provider,
                        costRecords: outcome.costRecords,
                        error: new ContextCompactionHardFitError(outcome.reason),
                    };
                }
                if (outcome.kind !== 'compacted') {
                    // A blocked outcome leaves context growing, so it must be visible in
                    // the log even though it is not a failure the user can act on.
                    if (outcome.kind === 'blocked') {
                        if (outcome.rearmAtTokens !== undefined) {
                            this.#blockedCompactionRearmAtEstimatedTokens = outcome.rearmAtTokens;
                            this.#blockedCompactionUserTurnCount = genuineUserTurns;
                        }
                        this.#logger.warn('Local context compaction blocked; continuing with uncompacted history', {
                            provider,
                            model,
                            reason: outcome.reason,
                            renderedInputTokens: outcome.estimate.renderedInputTokens,
                            ...(outcome.rearmAtTokens !== undefined ? { rearmAtEstimatedTokens: outcome.rearmAtTokens } : {}),
                        });
                        if (outcome.reason === 'no_complete_cold_turn') {
                            return {
                                kind: 'unchanged',
                                notice: 'Local compaction cannot shorten this history yet: it needs an older completed turn or settled tool rounds and preserves all user requests. ' +
                                    'Continue the current work; keep outputs concise and save durable progress. If session_rollover is available, consider it at a safe idle boundary; live background work survives rollover, so do not wait for it solely to rotate. Do not repeat completed work or manufacture user turns to force compaction.',
                            };
                        }
                    }
                    if (outcome.kind === 'blocked' && outcome.costRecords?.length)
                        return { kind: 'failed', provider, costRecords: outcome.costRecords };
                    return { kind: 'unchanged' };
                }
                this.#blockedCompactionRearmAtEstimatedTokens = undefined;
                this.#blockedCompactionUserTurnCount = undefined;
                if (outcome.droppedOpaqueItems > 0) {
                    this.#logger.debug('Local context compaction dropped provider-opaque items with their cold turns', {
                        provider,
                        model,
                        droppedOpaqueItems: outcome.droppedOpaqueItems,
                    });
                }
                const genuineUsers = history.filter((item) => {
                    const message = projectConversationMessage(item);
                    return message?.role === 'user' && !message.isSynthetic;
                });
                const hotUsers = outcome.hotTail.filter((item) => {
                    const message = projectConversationMessage(item);
                    return message?.role === 'user' && !message.isSynthetic;
                }).length;
                const preservedUsers = hotUsers === 0 ? genuineUsers : genuineUsers.slice(0, -hotUsers);
                const checkpointEvidence = {
                    history,
                    hotTail: outcome.hotTail,
                    checkpoint: outcome.checkpoint,
                    replaced: history.length - outcome.hotTail.length - preservedUsers.length,
                    index: preservedUsers.length,
                };
                this.#localCheckpointSink?.(checkpointEvidence);
                for (const observer of this.#localCheckpointObservers)
                    observer(checkpointEvidence);
                return {
                    kind: 'compacted',
                    history: [...preservedUsers, outcome.checkpoint, ...outcome.hotTail],
                    modelInput: [outcome.checkpoint, ...outcome.hotTail],
                    costRecords: outcome.costRecords,
                };
            },
        };
    }
    #observeContextMilestones(history, onReminder, lastCompletedInputTokens) {
        const provider = this.#agentConfig.getProvider();
        const model = this.#agentConfig.getModel();
        const catalog = getCatalogModel(provider, model);
        const agent = this.#agentConfig.getApplicationAgent();
        const estimate = estimateContext({
            history,
            instructions: agent.resolveInstructionsForRequest?.() ?? agent.instructions,
            tools: agent.tools,
            contextWindow: catalog?.contextWindow,
            maxOutputTokens: resolveRequestOutput(catalog, this.#agentConfig.getApplicationAgent().modelSettings?.maxTokens),
        });
        const measuredHardFitTokens = estimate.hardFitTokens + Math.max(0, (lastCompletedInputTokens ?? 0) - estimate.renderedInputTokens);
        const canSafelyDeferCompaction = catalog?.contextWindow !== undefined && measuredHardFitTokens <= catalog.contextWindow;
        const config = {
            enabled: this.#settings.get('agent.sessionRollover.enabled') ?? true,
            milestones: this.#settings.get('agent.sessionRollover.milestones') ?? [],
            autoBrief: this.#settings.get('agent.sessionRollover.autoBrief') ?? true,
        };
        const reminders = this.#contextMilestoneReminder.observe(lastCompletedInputTokens ?? this.#lastCompletedProviderInputTokens, config);
        for (const reminder of reminders) {
            onReminder(reminder);
        }
        return canSafelyDeferCompaction && (reminders.length > 0 || this.#sessionRolloverRequest !== null)
            ? { deferCompaction: true }
            : undefined;
    }
    /**
     * Forward real-time subagent activity events to the active conversation
     * turn. The session sets this for the duration of a send and clears it
     * afterwards so events reach the UI's onEvent callback.
     */
    setSubagentEventSink(sink) {
        return this.#subagentBridge?.setEventSink(sink);
    }
    /**
     * Forward subagent activity events to a conversation-scoped consumer that
     * stays attached across turns. Used to observe background (async) subagent
     * runs that settle while no turn is in flight.
     */
    setBackgroundSubagentEventSink(sink) {
        this.#subagentBridge?.setBackgroundEventSink(sink);
    }
    /** Session-owned queue/control delivery for pauses from adopted child runs. */
    setBackgroundSubagentApprovalPauseSink(sink) {
        this.#subagentBridge?.setBackgroundApprovalPauseSink(sink);
    }
    answerBackgroundSubagentQuestion(runId, messageId, answer) {
        return this.#subagentBridge?.answerBackgroundSubagentQuestion(runId, messageId, answer) === true;
    }
    requestSessionRollover(request) {
        const rolloverId = randomUUID();
        const pending = {
            ...request,
            rolloverId,
            requestedAt: Date.now(),
            ...(this.#lastCompletedProviderInputTokens !== undefined
                ? { providerInputTokens: this.#lastCompletedProviderInputTokens }
                : {}),
        };
        this.#sessionRolloverRequest ??= pending;
        return { ok: true, status: 'rollover_requested', rolloverId: this.#sessionRolloverRequest.rolloverId };
    }
    consumeSessionRolloverRequest() {
        const request = this.#sessionRolloverRequest;
        this.#sessionRolloverRequest = null;
        if (!request)
            return { status: 'none' };
        return { status: 'ready', request };
    }
    /** Exact nested-tool state shared with the subagent runtime's tool factory. */
    getNestedToolCompatibilityState() {
        return this.#subagentBridge?.getNestedToolCompatibilityState();
    }
    /** Route root shell-job lifecycle through the durable conversation sink. */
    setBackgroundShellEventSink(sink) {
        this.#backgroundShellRegistry?.setEventSink(sink ? (event) => sink(backgroundShellEventToConversationEvent(event)) : undefined);
        // Watch firings ride the same conversation lane: a firing is converted to
        // the background_shell_output conversation event and pushed to the sink,
        // so it is enqueued in exactly-once order with job completions.
        this.#backgroundShellOutput?.watches.setOnFiring(sink
            ? (firing) => {
                sink(backgroundShellEventToConversationEvent({
                    type: 'background_shell_output',
                    jobId: firing.jobId,
                    command: firing.command ?? '',
                    watchId: firing.watchId,
                    seq: firing.seq,
                    matchedLines: firing.matchedLines,
                    coalescedCount: firing.coalescedCount,
                    seqRange: firing.seqRange,
                    ...(firing.droppedBytes !== undefined ? { droppedBytes: firing.droppedBytes } : {}),
                }));
            }
            : undefined);
    }
    /** @deprecated Ordinary turn completion must not cancel background runs. */
    cancelSubagentRuns() {
        // Retained for the conversation adapter compatibility surface.
    }
    #resetMentorState() {
        this.#subagentBridge?.clearSubagentCache();
    }
    constructor({ driverFactory = createLegacyNestedRunDriver, modelBinding, adoptedProviderBinding, assembleAgent, selectApplicationAgent, validateApplicationAgent, selection, reasoningEffort, maxTurns, retryAttempts, agentOverride, approvalPolicyRegistry, deps, subagentBridge, toolOwnership, postExecutePauseCapability, sessionAccess, toolLifecycle, hookScope, backgroundShellRegistry, backgroundShellOutput, allowBackgroundShell = true, // Retained for session-factory compatibility; direct execution no longer
    allowAskUser = true, wrapUpOnCriticalRunBudget = false, 
    // projects chained input through the legacy mode.
    continuationProjectionMode: _continuationProjectionMode = 'legacy', }) {
        this.#logger = deps.logger;
        this.#adoptedProviderBinding = adoptedProviderBinding;
        this.#modelBinding = modelBinding;
        this.#selectApplicationAgent = selectApplicationAgent;
        this.#validateApplicationAgent = validateApplicationAgent;
        this.#toolInterceptorRegistry = new ToolInterceptorRegistry({ logger: this.#logger });
        this.#settings = deps.settings;
        this.#onGoalAchieved = deps.onGoalAchieved;
        this.#unattended = !allowAskUser;
        if (!agentOverride)
            this.#completionBoundary = new RootCompletionBoundary({
                driverFactory,
                settings: deps.settings,
                logger: deps.logger,
                executionContext: deps.executionContext,
                model: () => this.#agentConfig.getModel(),
                // Do not reuse the worker's cached transport or session context.
                resolveModel: (model) => {
                    if (this.#adoptedProviderBinding)
                        return this.#adoptedProviderBinding.independentModel(this.#agentConfig.getProvider(), model);
                    const provider = getProvider(this.#agentConfig.getProvider());
                    if (!provider?.createStreamedModel)
                        throw new Error('Independent verification provider unavailable');
                    return provider.createStreamedModel(model, { settingsService: deps.settings, loggingService: deps.logger });
                },
            });
        this.#sessionContextService = deps.sessionContextService;
        this.#providerRegistry = deps.providerRegistry;
        this.#toolLifecycle = toolLifecycle;
        this.#hookScope = hookScope ?? 'root';
        this.#backgroundShellRegistry = allowBackgroundShell ? backgroundShellRegistry : undefined;
        this.#backgroundShellOutput = allowBackgroundShell ? backgroundShellOutput : undefined;
        this.#wrapUpOnCriticalRunBudget = wrapUpOnCriticalRunBudget;
        this.#askUserAnswerStore = new AskUserAnswerStore();
        // Create AgentConfiguration (handles editor, model, provider, reasoning, etc.)
        this.#agentConfig = new AgentConfiguration({ selection, reasoningEffort, agentOverride, approvalPolicyRegistry }, {
            driverFactory,
            modelBinding,
            ...(assembleAgent ? { assembleAgent } : {}),
            ...(adoptedProviderBinding
                ? { providerCapabilities: (providerId) => adoptedProviderBinding.provider(providerId)?.capabilities }
                : {}),
            logger: deps.logger,
            settings: deps.settings,
            ...(deps.getGoal ? { getGoal: deps.getGoal } : {}),
            ...(deps.proposeGoal ? { proposeGoal: deps.proposeGoal } : {}),
            sessionContextService: deps.sessionContextService,
            executionContext: deps.executionContext,
            toolInterceptorRegistry: this.#toolInterceptorRegistry,
            askUserAnswerStore: this.#askUserAnswerStore,
            getSubagentBridge: () => this.#subagentBridge,
            skillsService: deps.skillsService,
            postExecutePauseCapability,
            sessionAccess,
            readOnly: deps.readOnly,
            allowUnsandboxed: deps.allowUnsandboxed,
            mcpToolSource: deps.mcpToolSource,
            backgroundShellRegistry: this.#backgroundShellRegistry,
            backgroundShellOutput: this.#backgroundShellOutput,
            shellChildRegistry: this.#shellChildRegistry,
            scopedSandbox: deps.scopedSandbox,
            allowBackgroundShell,
            allowAskUser,
            sessionBrowser: deps.sessionBrowser,
            discordSend: deps.discordSend,
            isDiscordInputEnabled: deps.isDiscordInputEnabled,
            onConfigChanged: (_changedKey) => {
                // Models capture provider/settings at creation time.
                this.#clearStreamedModelCache();
                this.#chatService?.clearModelCache();
                // Always clear subagent cache and reset mentor state
                this.#subagentBridge?.clearCache();
                this.#resetMentorState();
            },
            requestSessionRollover: deps.sessionBrowser
                ? (request) => this.requestSessionRollover(request)
                : undefined,
            configureTaskCheckIn: (params) => this.configureTaskCheckIn(params),
            setTaskCheckInPolicy: (target, options) => this.setTaskCheckInPolicy(target, options),
        });
        this.#maxTurns = maxTurns ?? (agentOverride ? 1 : 20);
        this.#retryAttempts = retryAttempts ?? 2;
        this.#requestCapture = deps.requestCapture;
        const decisionShadowObserver = agentOverride
            ? undefined
            : new DecisionShadowPilot({
                client: createOpenRouterDecisionClient({
                    resolveTransport: () => {
                        const apiKey = deps.settings.get('agent.openrouter.apiKey') || process.env.OPENROUTER_API_KEY || '';
                        const baseUrl = deps.settings.get('agent.openrouter.baseUrl');
                        return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
                    },
                }),
                resolveModel: () => deps.settings.get('agent.decisionModel'),
                logger: deps.logger,
            });
        this.#applicationRunLoop = new ApplicationRunLoop({
            toolLifecycle: this.#toolLifecycle,
            ...(decisionShadowObserver ? { decisionShadowObserver } : {}),
            contextCompactionSessionState: this.#contextCompactionSessionState,
            resolveMaxParallelToolCalls: () => deps.settings.get('agent.maxParallelToolCalls'),
            logDiagnostic: (message, meta, options = {}) => {
                const metadata = options.eventType ? { ...meta, eventType: options.eventType } : meta;
                if (options.severity === 'debug') {
                    deps.logger.debug(message, metadata);
                    return;
                }
                deps.logger.info(message, metadata);
            },
            resolveModel: (selectedModel) => this.#resolveStreamedModel(selectedModel),
        });
        this.#chatService = new AgentChatService({
            agentConfig: this.#agentConfig,
            settings: deps.settings,
            logger: deps.logger,
            sessionContextService: this.#sessionContextService,
            ...(modelBinding ? { modelBinding } : {}),
        });
        if (subagentBridge) {
            this.#subagentBridge = subagentBridge;
        }
        else if (!agentOverride) {
            this.#subagentBridge = new SubagentBridge({
                driverFactory,
                modelBinding,
                logger: deps.logger,
                settings: deps.settings,
                executionContext: deps.executionContext,
                sessionContextService: this.#sessionContextService,
                readOnly: deps.readOnly,
                scopedSandbox: deps.scopedSandbox,
                ...(deps.sessionBrowser ? { sessionBrowser: deps.sessionBrowser } : {}),
                chat: (message, options) => this.chat(message, options),
                // Factory lives here (not in SubagentBridge) so each subagent gets a
                // lightweight transient client that shares logger/settings/executionContext
                // with the parent but skips agent-rebuild and SubagentManager initialisation.
                createClient: ({ agent, provider, maxTurns, retryAttempts, agentId, role, approvalPolicyRegistry, }) => new AgentClient({
                    driverFactory,
                    modelBinding,
                    ...(adoptedProviderBinding && modelBinding
                        ? {
                            adoptedProviderBinding: {
                                ...adoptedProviderBinding,
                                model: (provider, model) => modelBinding.scopedModel({ provider, model }, {
                                    settingsService: deps.settings,
                                    loggingService: deps.logger,
                                    sessionContextService: this.#sessionContextService,
                                }),
                            },
                        }
                        : {}),
                    selection: { model: agent.model, provider },
                    maxTurns,
                    retryAttempts,
                    approvalPolicyRegistry,
                    deps: {
                        logger: deps.logger,
                        settings: deps.settings,
                        executionContext: deps.executionContext,
                        sessionContextService: this.#sessionContextService,
                        skillsService: deps.skillsService,
                        readOnly: deps.readOnly,
                    },
                    agentOverride: agent,
                    toolOwnership,
                    wrapUpOnCriticalRunBudget: true,
                    ...(this.#toolLifecycle && agentId
                        ? {
                            toolLifecycle: createScopedToolLifecycle(this.#toolLifecycle, {
                                agentId,
                                role: role ?? agent.name,
                            }),
                            hookScope: { subagent: { agentId, role: role ?? agent.name } },
                        }
                        : {}),
                }),
                skillsService: deps.skillsService,
                toolOwnership,
            });
        }
        if (!agentOverride) {
            // Subscribe to settings changes via AgentConfiguration
            this.#agentConfig.subscribeToSettings();
            this.#logger.debug('OpenAI Agent Client initialized', {
                model: this.#agentConfig.getModel(),
                reasoningEffort: reasoningEffort ?? 'default',
                temperature: this.#agentConfig.temperature,
                maxTurns: this.#maxTurns,
                retryAttempts: this.#retryAttempts,
            });
        }
    }
    /**
     * Wire session tool-ledger dispatch marking. Called after composition creates
     * the tracker so mid-tool stream recovery can settle as `unknown`.
     */
    setLocalCheckpointSink(sink) {
        this.#localCheckpointSink = sink;
    }
    addLocalCheckpointObserver(observer) {
        this.#localCheckpointObservers.add(observer);
        return () => this.#localCheckpointObservers.delete(observer);
    }
    getRuntimeSettingsSnapshot() {
        const reasoningEffort = this.#agentConfig.reasoningEffort ?? 'default';
        const temperature = this.#agentConfig.temperature;
        return {
            selection: { provider: this.#agentConfig.getProvider(), model: this.#agentConfig.getModel() },
            reasoningEffort,
            ...(temperature === undefined ? {} : { temperature }),
        };
    }
    setModelSelection(selection) {
        this.#agentConfig.setModelSelection(selection);
        this.#agentConfig.refreshAgent();
    }
    resetMemoryContextForNewSession() {
        this.#agentConfig.resetMemoryContextForNewSession();
    }
    setReasoningEffort(effort) {
        this.#agentConfig.setReasoningEffort(effort);
        this.#agentConfig.refreshAgent();
    }
    setTemperature(temperature) {
        this.#agentConfig.setTemperature(temperature);
        this.#agentConfig.refreshAgent();
    }
    getProvider() {
        return this.#agentConfig.getProvider();
    }
    supportsConversationChaining() {
        return ((this.#adoptedProviderBinding
            ? this.#adoptedProviderBinding.provider(this.#agentConfig.getProvider())
            : getProvider(this.#agentConfig.getProvider(), this.#providerRegistry))?.capabilities?.supportsConversationChaining ?? false);
    }
    setAskUserAnswer(callId, answer) {
        this.#askUserAnswerStore.set(callId, answer);
    }
    getAskUserAnswer(callId) {
        if (!callId)
            return undefined;
        return this.#askUserAnswerStore.consume(callId);
    }
    addToolInterceptor(interceptor) {
        return this.#toolInterceptorRegistry.add(interceptor);
    }
    useStandardServiceTierForNextRequest() {
        this.#agentConfig.serviceTierOverrideForNextRequest = 'standard';
        this.#agentConfig.refreshAgent();
    }
    setRetryCallback(callback) {
        this.#retryCallback = callback;
    }
    /**
     * Abort the current running stream/operation, including the foreground
     * subagent work of the running turn. Conversation-bound background (async)
     * subagent runs are unaffected — see {@link cancelBackgroundRuns}.
     */
    abort() {
        this.#abortActiveWork(() => this.#applicationRunLoop.abort());
    }
    /**
     * Stop whatever is streaming, deciding only whether the turn dies with it.
     *
     * Resuming a paused turn passes through here too, and must not take the
     * turn's injections down: they are waiting for the very segment about to
     * start. Only a caller that means to end the turn discards them.
     */
    #abortActiveWork(abortRunLoop) {
        const traceId = this.#currentCorrelationId ?? this.#logger.getCorrelationId?.();
        this.#activeStartController?.abort();
        this.#activeStartController = null;
        abortRunLoop();
        this.#clearCorrelationId();
        this.#logger.debug('Agent operation aborted', {
            eventType: 'stream.aborted',
            category: 'stream',
            phase: 'abort',
            traceId,
        });
        this.#chatService.abort();
        this.#subagentBridge?.abort();
    }
    /**
     * Mark the boundaries of a turn for the run loop, which otherwise sees only
     * the individual streams a turn is made of and cannot tell its first stream
     * from a retry of its last. Called by the component that owns turn identity
     * (`TurnCoordinator`); a caller that drives streams directly may skip them
     * and keep the stream-scoped behaviour.
     */
    openTurn() {
        this.#applicationRunLoop.openTurn();
    }
    closeTurn() {
        this.#applicationRunLoop.closeTurn();
    }
    /**
     * The settings envelope, with the turn backstop honoring `agent.maxTurns`.
     *
     * A run budget suppresses the loop's `MaxTurnsExceededError`, so without this
     * a configured `agent.maxTurns: 10` would silently stop meaning anything and
     * the run would go all the way to `turnBackstop`. Taking the tighter of the
     * two keeps the live setting effective while leaving the backstop's role as
     * the infinite-loop tripwire intact.
     */
    #runBudgetPolicy() {
        const policy = readRunBudgetPolicy(this.#settings);
        return { ...policy, turnBackstop: Math.min(policy.turnBackstop, this.#maxTurns) };
    }
    /** Root-only active-goal stop check; transient clients never receive one. */
    #goalStopCheck() {
        const getGoal = this.#agentConfig.goalSource;
        if (!getGoal)
            return undefined;
        if (this.#settings.get('agent.completionVerification') === false || !this.#completionBoundary) {
            return createGoalStopPolicy(getGoal, this.#onGoalAchieved);
        }
        return createVerifiedGoalStopPolicy({
            getGoal,
            // Bare must not turn an unavailable required review into successful headless completion.
            unattended: this.#unattended && this.#settings.get('app.activeProfileId') !== 'builtin:bare',
            onGoalAchieved: this.#onGoalAchieved,
            verify: (goal, history, signal) => this.#completionBoundary.verify(goal, history, signal),
        });
    }
    /** Grant one finite extension to the active run-budget envelope. */
    grantRunBudgetExtension() {
        return this.#applicationRunLoop.grantRunBudgetExtension();
    }
    /**
     * Hand the running turn a user message for its next model request. Resolves
     * `'released'` when the turn offers no further request boundary, leaving the
     * caller to send the message as its own turn.
     */
    steer(items, options) {
        return this.#applicationRunLoop.steer(items, options);
    }
    /** Drop a still-waiting steer. False when it was already admitted. */
    retractSteer(id) {
        return this.#applicationRunLoop.retractSteer(id);
    }
    /** Replace a waiting steer's items in place, keeping its position. */
    editSteer(id, items) {
        return this.#applicationRunLoop.editSteer(id, items);
    }
    /**
     * Cancel conversation-bound background (async) subagent runs. Reserved for an
     * explicit user interrupt, conversation disposal, or shutdown.
     */
    cancelBackgroundRuns() {
        this.#subagentBridge?.cancelBackgroundRuns();
    }
    getBackgroundSubagentStatus(runId) {
        return (this.#subagentBridge?.getBackgroundSubagentStatus(runId) ?? {
            runId,
            role: '',
            status: 'not_found',
            task: '',
            taskPreview: '',
            startedAt: 0,
            elapsedMs: 0,
            toolCounts: {},
        });
    }
    getApprovalPolicyRegistry() {
        return this.#agentConfig.approvalPolicyRegistry;
    }
    setNestedApprovalOwner(owner) {
        this.#agentConfig.setNestedApprovalOwner(owner);
    }
    listBackgroundSubagentStatuses() {
        return this.#subagentBridge?.listBackgroundSubagentStatuses() ?? [];
    }
    requestBackgroundSubagentStop(runId) {
        return (this.#subagentBridge?.requestBackgroundSubagentStop(runId) ?? { ok: false, code: 'not_active', target: runId });
    }
    /** Foreground runs that can be moved without constructing a second execution. */
    listForegroundSubagentCandidates() {
        return this.#subagentBridge?.listForegroundSubagentCandidates() ?? [];
    }
    /** Atomically hands one live nested child to the background registry. */
    moveForegroundSubagent(runId) {
        return this.#subagentBridge?.moveForegroundSubagent(runId);
    }
    getBackgroundShellJob(jobId) {
        return this.#backgroundShellRegistry?.get(jobId);
    }
    listBackgroundShellJobs() {
        return this.#backgroundShellRegistry?.list() ?? [];
    }
    getBackgroundShellOutputTail(jobId, maxBytes) {
        return this.#backgroundShellOutput?.store.readTail(jobId, maxBytes)?.text;
    }
    requestBackgroundShellStop(jobId) {
        return this.#backgroundShellRegistry?.cancel(jobId) ?? false;
    }
    /** The current root shell call that can still be detached from its turn. */
    getForegroundShellTransferCandidate() {
        return this.#backgroundShellRegistry?.listForeground()[0];
    }
    /** Atomically detaches a root shell call from its foreground turn. */
    moveForegroundShellToBackground(callId) {
        return this.#backgroundShellRegistry?.adoptForeground(callId);
    }
    cancelBackgroundShellJobs() {
        for (const job of this.#backgroundShellRegistry?.list() ?? []) {
            this.#backgroundShellRegistry?.cancel(job.id);
        }
    }
    setBackgroundCheckInScheduler(scheduler) {
        this.#backgroundCheckInScheduler = scheduler;
    }
    configureTaskCheckIn(params) {
        if (!this.#backgroundCheckInScheduler) {
            return { ok: false, error: 'Background check-in scheduler is not active.' };
        }
        if (params.interval_seconds !== undefined && params.interval_seconds < MIN_CHECK_IN_INTERVAL_SECONDS) {
            return {
                ok: false,
                error: `interval_seconds must be at least ${MIN_CHECK_IN_INTERVAL_SECONDS} seconds (5 minutes).`,
            };
        }
        if (params.next_check_in_seconds !== undefined && params.next_check_in_seconds < MIN_NEXT_CHECK_IN_SECONDS) {
            return {
                ok: false,
                error: `next_check_in_seconds must be at least ${MIN_NEXT_CHECK_IN_SECONDS} seconds.`,
            };
        }
        return this.#backgroundCheckInScheduler.configureTaskCheckIn(params.target, {
            enabled: params.enabled,
            intervalMs: params.interval_seconds !== undefined ? params.interval_seconds * 1000 : undefined,
            nextDueInMs: params.next_check_in_seconds !== undefined ? params.next_check_in_seconds * 1000 : undefined,
        });
    }
    setTaskCheckInPolicy(target, options) {
        this.#backgroundCheckInScheduler?.setTaskPolicy(target, options);
    }
    disposeBackgroundShellJobs() {
        return this.#backgroundShellRegistry?.dispose() ?? Promise.resolve();
    }
    disposeShellChildren() {
        this.#shellChildRegistry.killAll();
    }
    /** Await adopted child-run settlement before the session detaches its sinks. */
    disposeBackgroundSubagents() {
        return this.#subagentBridge?.disposeBackgroundSubagents() ?? Promise.resolve();
    }
    /** Await simple-chat provider cleanup in short-lived batch clients. */
    disposeChatModels() {
        return this.#chatService.dispose();
    }
    /** End all session-bound activity and release resources held by this client. */
    dispose() {
        if (this.#isDisposed)
            return;
        this.#isDisposed = true;
        this.abort();
        this.disposeShellChildren();
        void this.disposeBackgroundShellJobs();
        this.#clearStreamedModelCache();
        void this.disposeChatModels();
        this.#subagentBridge?.dispose();
        this.#agentConfig.dispose();
        this.#completionBoundary?.dispose();
        this.#blockedCompactionRearmAtEstimatedTokens = undefined;
        this.#blockedCompactionUserTurnCount = undefined;
    }
    clearConversations() {
        this.#applicationRunLoop.abort();
        this.#blockedCompactionRearmAtEstimatedTokens = undefined;
        this.#blockedCompactionUserTurnCount = undefined;
        (this.#adoptedProviderBinding
            ? this.#adoptedProviderBinding.provider(this.#agentConfig.getProvider())
            : getProvider(this.#agentConfig.getProvider()))?.clearConversations?.();
        this.#agentConfig.refreshAgent();
        this.#logger.debug('Conversation and agent refreshed');
    }
    /**
     * Rollover deliberately does not use clearConversations(): that public
     * operation refreshes the whole client and is allowed to tear down normal
     * conversation resources. Only the root request lane is reset here; nested
     * clients and their live background work remain owned by the bridge.
     */
    rolloverRootContext() {
        this.#applicationRunLoop.abort();
        this.#clearCorrelationId();
        // Keep the state object captured by an already-created provider model.
        // Replacing it would leave the retained model bound to an obsolete
        // compaction state object.
        this.#contextCompactionSessionState.disabled = false;
        this.#contextMilestoneReminder = new ContextMilestoneReminder();
        this.#sessionRolloverRequest = null;
        this.#lastCompletedProviderInputTokens = undefined;
        this.#askUserAnswerStore.clear();
        const resetOptions = this.#lastLogicalSessionId
            ? { providerHistoryKey: this.#lastLogicalSessionId }
            : undefined;
        for (const [cacheKey, cached] of this.#streamedModelCache) {
            // A retained root reset must never reach a transient client's borrowed
            // model. Its provider state may be shared with a live nested sibling,
            // while the root reset is scoped only to the root history key.
            if (cached.ownership !== 'owned')
                continue;
            const reset = (model) => {
                const resetModel = findConversationResetModel(model);
                if (resetModel) {
                    if (!resetOptions)
                        return;
                    resetModel.resetConversationState(resetOptions);
                    this.#unavailableCodexCompaction.delete(model);
                    return;
                }
                // A provider without the reset seam has not proved that its cached
                // state is safe to carry into a new logical session. Recreate it rather
                // than silently retaining unknown conversation state.
                this.#discardStreamedModel(cacheKey, cached);
            };
            if (cached.model instanceof Promise) {
                void cached.model.then(reset).catch(() => undefined);
            }
            else {
                reset(cached.model);
            }
        }
        this.#chatService.clearModelCache();
    }
    #clearCorrelationId() {
        if (this.#currentCorrelationId) {
            this.#logger.clearCorrelationId();
            this.#currentCorrelationId = null;
        }
    }
    async #prepareStart(userInput, options, signal, abortPendingModelReads = false, onDetachedModelRead) {
        let agentRefreshed = false;
        if (this.#agentConfig.getProvider() === 'codex' && this.#settings.get('agent.reasoningEffort') === 'default') {
            try {
                const discovery = this.#modelBinding
                    ? this.#modelBinding.fetchModels('codex', {
                        settingsService: this.#settings,
                        loggingService: this.#logger,
                        signal,
                    })
                    : fetchModels({ settingsService: this.#settings, loggingService: this.#logger, signal }, 'codex');
                if (abortPendingModelReads)
                    await waitForAbortableRead(discovery, signal, onDetachedModelRead);
                else
                    await discovery;
                if (signal.aborted)
                    throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
                this.#agentConfig.refreshAgent({ configurationChanged: false });
                agentRefreshed = true;
            }
            catch {
                if (signal.aborted)
                    throw new DOMException('The operation was aborted.', 'AbortError');
                // Model discovery is best effort; the provider can still resolve its default.
            }
        }
        if (signal.aborted)
            throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
        const isFirstMessage = !options.previousResponseId && (!Array.isArray(userInput) || (userInput.length > 0 && userInput.length <= 1));
        if (isFirstMessage && !agentRefreshed)
            this.#agentConfig.refreshAgent({ configurationChanged: false });
        this.#currentCorrelationId = randomUUID();
        this.#logger.setCorrelationId(this.#currentCorrelationId);
        this.#logger.debug('Agent stream started', {
            eventType: 'provider.request.started',
            category: 'provider',
            phase: 'request_start',
            traceId: this.#currentCorrelationId,
            provider: this.#agentConfig.getProvider(),
            model: this.#agentConfig.getModel(),
            inputType: Array.isArray(userInput) ? 'array' : typeof userInput,
            inputLength: typeof userInput === 'string' ? userInput.length : undefined,
            inputItems: Array.isArray(userInput) ? userInput.length : undefined,
            messages: Array.isArray(userInput) ? userInput : undefined,
            hasPreviousResponseId: !!options.previousResponseId,
        });
    }
    #observeCompletion(stream, input, provider, model) {
        const correlationId = this.#currentCorrelationId;
        const cleanup = () => {
            if (this.#agentConfig.serviceTierOverrideForNextRequest === 'standard') {
                this.#agentConfig.serviceTierOverrideForNextRequest = null;
                this.#agentConfig.refreshAgent();
            }
            if (this.#currentCorrelationId === correlationId)
                this.#clearCorrelationId();
        };
        void stream.completed.then(() => {
            if (stream.latestProviderInputTokens !== undefined) {
                this.#lastCompletedProviderInputTokens = stream.latestProviderInputTokens;
                if (this.#sessionRolloverRequest) {
                    this.#sessionRolloverRequest.providerInputTokens = stream.latestProviderInputTokens;
                }
            }
            cleanup();
        }, (error) => {
            const failure = classifyProviderFailure(error);
            const metadata = {
                traceId: correlationId ?? undefined,
                provider,
                model,
                error: failure.message,
                errorKind: failure.errorKind,
                code: failure.code,
                status: failure.status,
                retryAfterMs: failure.retryAfterMs,
                retryable: failure.retryable,
                inputType: Array.isArray(input) ? 'array' : typeof input,
                inputLength: typeof input === 'string' ? input.length : undefined,
                inputItems: Array.isArray(input) ? input.length : undefined,
            };
            if (failure.errorKind === 'cancelled') {
                this.#logger.debug('Agent stream cancelled', {
                    ...metadata,
                    eventType: 'stream.aborted',
                    category: 'stream',
                    phase: 'abort',
                });
            }
            else {
                this.#logger.error('Agent stream failed', {
                    ...metadata,
                    eventType: 'provider.response.failed',
                    category: 'provider',
                    phase: 'provider_response',
                });
            }
            cleanup();
        });
    }
    #openAIRequestPreparation(options) {
        const provider = this.#agentConfig.getProvider();
        const snapshot = options.providerHistorySnapshot;
        if (provider !== 'openai' ||
            this.#agentConfig.isTransientClient ||
            !snapshot ||
            options.providerContinuityLineage === undefined) {
            return undefined;
        }
        const binding = {
            snapshotIdentity: snapshot.identity,
            snapshotRevision: snapshot.revision,
            lineage: options.providerContinuityLineage,
        };
        let canonicalSnapshot;
        try {
            canonicalSnapshot = normalizeApplicationInput(snapshot.history);
        }
        catch {
            // A malformed/restored snapshot must never establish provider-private
            // ownership. The application request itself still proceeds normally.
            return undefined;
        }
        return {
            prepare: (request) => {
                // Bind only the actual request selected by the application run loop,
                // not a guessed continuation-state prefix. The OpenAI transport
                // consumes the application-owned input directly.
                if (!isDeepStrictEqual(canonicalSnapshot, request.input))
                    return;
                prepareOpenAIRequestPrefixBinding(binding, request.input);
            },
            // Keep the handoff alive through the complete async model invocation.
            run: (operation) => runWithOpenAIRequestPrefixBindingScope(operation),
        };
    }
    #applicationOptions(options) {
        const provider = this.#agentConfig.getProvider();
        const supportsChaining = this.supportsConversationChaining();
        const requestPreparation = this.#openAIRequestPreparation(options);
        const boundaryCompaction = this.#boundaryCompaction();
        const runBudget = this.#runBudgetPolicy();
        const goalStopCheck = this.#goalStopCheck();
        return {
            requestInputLimit: () => this.#settings.get('agent.maxRequestInputTokens'),
            ...(boundaryCompaction ? { boundaryCompaction } : {}),
            ...(requestPreparation ? { requestPreparation } : {}),
            ...(supportsChaining && options.previousResponseId && !options.disableChainingForAttempt
                ? { previousResponseId: options.previousResponseId }
                : {}),
            ...(options.providerHistorySnapshot ? { compactionHistory: options.providerHistorySnapshot.history } : {}),
            ...(options.disableChainingForAttempt ? { disableChainingForAttempt: true } : {}),
            ...(options.recoveryBudget ? { recoveryBudget: options.recoveryBudget } : {}),
            providerId: provider,
            supportsConversationChaining: supportsChaining,
            sessionId: options.sessionId,
            turnId: options.hookTurnId,
            hookScope: this.#hookScope,
            ...(options.sessionId ? { context: { sessionId: options.sessionId } } : {}),
            maxTurns: this.#maxTurns,
            runBudget,
            ...(this.#wrapUpOnCriticalRunBudget ? { wrapUpOnCriticalRunBudget: true } : {}),
            ...(options.onRunBudgetEvent ? { onRunBudgetEvent: options.onRunBudgetEvent } : {}),
            onRequestBoundary: (history, onReminder, observation) => {
                if (observation.compactionSkipReason) {
                    this.#logger.debug('Automatic context compaction skipped without aligned chained history', {
                        reason: observation.compactionSkipReason,
                        measuredInputTokens: observation.lastCompletedInputTokens ?? 0,
                    });
                }
                return this.#observeContextMilestones(history, onReminder, observation.lastCompletedInputTokens);
            },
            ...(options.stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
            ...(goalStopCheck ? { onNormalStop: goalStopCheck } : {}),
        };
    }
    async #prepareApplicationTurn(userInput, options = {}, abortPendingModelReads = false, onDetachedModelRead) {
        this.#subagentBridge?.resetAbortController();
        // Stop whatever is streaming without judging the turn's fate: a retry
        // restarts the stream of the turn already in progress, and the turn-ending
        // abort() here discarded the injections waiting for the very segment about
        // to start. Same distinction as continueRunStream. A genuinely new turn is
        // settled by the run loop instead — see its startStream and openTurn.
        // Allocate the controller before the first await: Codex model discovery can
        // suspend startStream, and this must still cancel that not-yet-started run.
        this.#abortActiveWork(() => this.#applicationRunLoop.abortSegment());
        const startController = new AbortController();
        this.#activeStartController = startController;
        if (options.sessionId)
            this.#lastLogicalSessionId = options.sessionId;
        if (options.sessionId)
            this.#lastPromptCacheKey = options.promptCacheKey ?? options.sessionId;
        try {
            this.#validateApplicationAgent?.(this.#agentConfig.getApplicationAgent(options.sessionId, options.promptCacheKey), this.#agentConfig.getProvider());
            await this.#prepareStart(userInput, options, startController.signal, abortPendingModelReads, onDetachedModelRead);
            if (startController.signal.aborted) {
                throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
            }
            this.#agentConfig.beginTurn();
            const assembledAgent = this.#agentConfig.getApplicationAgent(options.sessionId, options.promptCacheKey);
            this.#validateApplicationAgent?.(assembledAgent, this.#agentConfig.getProvider());
            const agent = this.#selectApplicationAgent?.(assembledAgent) ?? assembledAgent;
            this.#activeStartController = null;
            return { agent, input: userInput, options: this.#applicationOptions(options) };
        }
        catch (error) {
            if (this.#activeStartController === startController)
                this.#activeStartController = null;
            throw error;
        }
    }
    async startStream(userInput, options = {}) {
        const start = await this.#prepareApplicationTurn(userInput, options, Boolean(this.#modelBinding), this.#modelBinding?.trackDetachedRead);
        const stream = this.#applicationRunLoop.startStream(start.agent, start.input, start.options);
        this.#observeCompletion(stream, userInput, this.#agentConfig.getProvider(), this.#agentConfig.getModel());
        return stream;
    }
    async runTurn(session) {
        await this.#applicationRunLoop.runTurn({
            ...(session.approvalBatch ? { approvalBatch: true } : {}),
            ...(session.abortPendingModelReads ? { abortPendingModelReads: true } : {}),
            ...(session.recordBudgetStopCause ? { recordBudgetStopCause: true } : {}),
            ...(session.onDetachedModelRead ? { onDetachedModelRead: session.onDetachedModelRead } : {}),
            prepare: async (signal) => {
                const preparation = session.prepare(signal);
                const start = session.abortPendingModelReads
                    ? await waitForAbortableRead(preparation, signal, session.onDetachedModelRead)
                    : await preparation;
                if (session.abortPendingModelReads)
                    signal.throwIfAborted();
                if (!start)
                    return undefined;
                const operation = this.#prepareApplicationTurn(start.input, start.options, session.abortPendingModelReads, session.onDetachedModelRead);
                const prepared = session.abortPendingModelReads
                    ? await waitForAbortableRead(operation, signal, session.onDetachedModelRead)
                    : await operation;
                if (session.abortPendingModelReads)
                    signal.throwIfAborted();
                return prepared;
            },
            beginSegment: (stream) => session.beginSegment(stream),
            acceptEvent: (event) => session.acceptEvent(event),
            acceptToolDispatch: (callId) => session.acceptToolDispatch(callId),
            ...(session.onModelDispatch ? { onModelDispatch: (input) => session.onModelDispatch(input) } : {}),
            ...(session.beforeToolDispatch
                ? { beforeToolDispatch: (callId) => session.beforeToolDispatch(callId) }
                : {}),
            ...(session.isFatalError ? { isFatalError: (error) => session.isFatalError(error) } : {}),
            acceptSegment: (stream) => session.acceptSegment(stream),
            completed: (stream) => session.completed(stream),
            consume: async (stream) => {
                this.#observeCompletion(stream, stream.state, this.#agentConfig.getProvider(), this.#agentConfig.getModel());
                await session.consume(stream);
            },
            interrupted: async (stream) => this.#applicationOptions(await session.interrupted(stream)),
            recover: (error) => session.recover(error),
        });
    }
    async continueRunStream(state, options = {}) {
        this.#subagentBridge?.resetAbortController();
        // Reconnect to the suspended task. Transport cleanup may reset client
        // bookkeeping, but aborting the loop here would destroy its approval wait.
        this.#abortActiveWork(() => undefined);
        const provider = this.#agentConfig.getProvider();
        if (options.sessionId)
            this.#lastLogicalSessionId = options.sessionId;
        const stream = this.#applicationRunLoop.continueRunStream(state, this.#applicationOptions(options));
        this.#observeCompletion(stream, state, provider, this.#agentConfig.getModel());
        return stream;
    }
    async compactCodexSessionHistory(history, signal) {
        const outcome = await this.#compactCodexHistory({
            history,
            model: this.#agentConfig.getModel(),
            automaticCompactionsThisRun: 0,
            signal,
            onStarted: () => undefined,
            manual: true,
        });
        if (outcome.kind === 'compacted')
            return { kind: 'compacted', history: outcome.history };
        return outcome;
    }
    async chat(message, options = {}) {
        return this.#chatService.chat(message, options);
    }
    async chatDetailed(message, options = {}) {
        return this.#chatService.chatDetailed(message, options);
    }
    async chatJson(message, options) {
        return this.#chatService.chatJson(message, options);
    }
    getSettings() {
        return this.#settings;
    }
}
function backgroundShellEventToConversationEvent(event) {
    if (event.type === 'background_shell_started') {
        return event;
    }
    if (event.type === 'background_shell_output') {
        return {
            type: 'background_shell_output',
            jobId: event.jobId,
            command: event.command,
            watchId: event.watchId,
            seq: event.seq,
            matchedLines: event.matchedLines,
            ...(event.coalescedCount !== undefined ? { coalescedCount: event.coalescedCount } : {}),
            ...(event.seqRange !== undefined ? { seqRange: event.seqRange } : {}),
            ...(event.droppedBytes !== undefined ? { droppedBytes: event.droppedBytes } : {}),
        };
    }
    return {
        type: 'background_shell_completed',
        jobId: event.jobId,
        command: event.command,
        status: event.status,
        output: event.output?.output ?? event.error ?? '',
        ...(event.error ? { error: event.error } : {}),
    };
}
//# sourceMappingURL=agent-client.js.map