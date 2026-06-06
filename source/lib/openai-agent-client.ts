import { Agent, run, type AgentInputItem, Runner, type JsonSchemaDefinition } from '@openai/agents';
import { buildAgent, type AgentFactoryDeps } from './agent-factory.js';
import { getProvider } from '../providers/index.js';
import { type FallbackState } from '../providers/fallback-responses-model.js';
import type { ModelProvider } from '@openai/agents-core/model';
import { type ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import { randomUUID } from 'node:crypto';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import { ExecutionContext } from '../services/execution-context.js';
import { createEditorImpl } from './editor-impl.js';
import { isFlexServiceTierTimeout } from '../utils/flex-service-tier.js';
import { SubagentManager } from '../services/subagents/subagent-manager.js';
import type { ConversationEvent } from '../services/conversation-events.js';
import { fetchModels, getModelDefaultReasoningLevel } from '../services/model-service.js';
import { filterChainedModelInput, type ChainedModelInputFilterOptions } from './chained-input-filter.js';

type ChainedRunOptions = {
  previousResponseId?: string | null;
  sessionId?: string;
  toolResultCallIds?: readonly string[];
};

/**
 * Narrowed provider interface so we can access {@link FallbackState}
 * without casting through `any`.
 */
interface ModelProviderWithFallback extends ModelProvider {
  fallbackState?: FallbackState;
}

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class OpenAIAgentClient {
  #agent: Agent;
  #model!: string;
  // Accept 'default' here to denote 'do not pass this param; use API default'
  #reasoningEffort?: ModelSettingsReasoningEffort | 'default';
  #temperature?: number;
  #provider: string;
  #maxTurns: number;
  #retryAttempts: number;
  #currentAbortController: AbortController | null = null;
  #currentCorrelationId: string | null = null;
  #runner: Runner | null = null;

  #serviceTierOverrideForNextRequest: 'standard' | null = null;
  #toolInterceptors: ((name: string, params: any, toolCallId?: string) => Promise<string | null>)[] = [];
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #executionContext?: ExecutionContext;
  #editor: ReturnType<typeof createEditorImpl>;
  #subagentManager: SubagentManager | null = null;
  #isTransientClient = false;
  #subagentEventSink: ((event: ConversationEvent) => void) | null = null;
  #activeSubagentsCount = 0;
  #pendingClearSink = false;
  #askUserAnswers = new Map<string, string>();
  #lastChainedDeltaInputItems: number | null = null;

  #onDowngradeCallback?: () => void;

  /**
   * Registers a callback that will be triggered when the provider transport downgrades to HTTP.
   * If the current runner is already downgraded, the callback is invoked immediately.
   */
  onDowngrade(callback: () => void): void {
    this.#onDowngradeCallback = callback;
    if (this.#runner) {
      this.#applyDowngradeCallbackToRunner(this.#runner);
    }
  }

  #applyDowngradeCallbackToRunner(runner: Runner | null): void {
    if (!runner) return;
    const provider = runner.config?.modelProvider as ModelProviderWithFallback;
    const fallbackState = provider?.fallbackState;
    if (fallbackState) {
      if (fallbackState.isDowngraded) {
        this.#onDowngradeCallback?.();
      } else {
        fallbackState.onDowngrade = () => {
          this.#onDowngradeCallback?.();
        };
      }
    }
  }

  /**
   * Returns the FallbackState from the current provider's model, if available.
   * This allows the session to react when the WS transport degrades to HTTP.
   */
  getFallbackState(): FallbackState | null {
    const runner = this.#runner;
    if (!runner) return null;
    const provider = runner.config?.modelProvider as ModelProviderWithFallback;
    return provider?.fallbackState ?? null;
  }

  /**
   * Force the current fallback-capable provider onto HTTP transport.
   * Returns false when the active provider has no fallback transport or is already downgraded.
   */
  forceTransportDowngrade(error: unknown): boolean {
    const fallbackState = this.getFallbackState();
    if (!fallbackState || fallbackState.isDowngraded || typeof fallbackState.forceDowngrade !== 'function') {
      return false;
    }
    fallbackState.forceDowngrade(error);
    return fallbackState.isDowngraded;
  }

  /**
   * Forward real-time subagent activity events to the active conversation
   * turn. The session sets this for the duration of a send and clears it
   * afterwards so events reach the UI's onEvent callback.
   */
  setSubagentEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    if (sink === null && this.#activeSubagentsCount > 0) {
      this.#pendingClearSink = true;
    } else {
      this.#subagentEventSink = sink;
      this.#pendingClearSink = false;
    }
  }

  #resetMentorState(): void {
    if (this.#subagentManager) {
      this.#subagentManager.resetMentorSession();
    }
  }

  constructor({
    model,
    reasoningEffort,
    maxTurns,
    retryAttempts,
    agentOverride,
    providerOverride,
    deps,
  }: {
    model?: string;
    reasoningEffort?: ModelSettingsReasoningEffort | 'default';
    maxTurns?: number;
    retryAttempts?: number;
    agentOverride?: Agent;
    providerOverride?: string;
    deps: {
      logger: ILoggingService;
      settings: ISettingsService;
      executionContext?: ExecutionContext;
      sessionContextService: ISessionContextService;
    };
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#executionContext = deps.executionContext;
    this.#editor = createEditorImpl({
      loggingService: this.#logger,
      settingsService: this.#settings,
      executionContext: this.#executionContext,
    });
    this.#reasoningEffort = reasoningEffort;
    this.#temperature = this.#settings.get<number | undefined>('agent.temperature');
    if (agentOverride) {
      this.#isTransientClient = true;
      this.#agent = agentOverride;
      this.#model = model ?? (agentOverride as any).model ?? '';
      this.#maxTurns = maxTurns ?? 1;
      this.#retryAttempts = retryAttempts ?? 2;
    } else {
      const buildResult = buildAgent({ model, reasoningEffort }, this.#buildFactoryDeps());
      this.#agent = buildResult.agent;
      this.#model = buildResult.resolvedModel;
      this.#maxTurns = maxTurns ?? 20;
      this.#retryAttempts = retryAttempts ?? 2;
    }
    this.#provider = providerOverride ?? this.#settings.get<string>('agent.provider') ?? 'openai';
    this.#runner = null;

    if (!agentOverride) {
      this.#subagentManager = new SubagentManager({
        logger: deps.logger,
        settings: deps.settings,
        executionContext: deps.executionContext,
        sessionContextService: this.#sessionContextService,
        onEvent: (event) => this.#subagentEventSink?.(event),
        agentClient: { chat: (message, options) => this.chat(message, options) },
        // Factory lives here (not in SubagentManager) so each subagent gets a
        // lightweight transient client that shares logger/settings/executionContext
        // with the parent but skips agent-rebuild and SubagentManager initialisation.
        createClient: ({
          agent,
          provider,
          maxTurns,
          retryAttempts,
        }: {
          agent: any;
          provider: string;
          maxTurns: number;
          retryAttempts?: number;
        }) =>
          new OpenAIAgentClient({
            model: agent.model,
            maxTurns,
            retryAttempts,
            deps: {
              logger: deps.logger,
              settings: deps.settings,
              executionContext: deps.executionContext,
              sessionContextService: this.#sessionContextService,
            },
            agentOverride: agent,
            providerOverride: provider,
          }),
      });
    }

    if (!agentOverride) {
      // Subscribe to settings changes that affect agent definition (prompt,
      // tools, model, provider, modes) and rebuild the agent automatically.
      this.#settings.onChange?.((changedKey) => {
        if (!changedKey) return;
        // Keys that require a full agent rebuild:
        const rebuildKeys = [
          'app.liteMode',
          'app.orchestratorMode',
          'app.planMode',
          'app.mentorMode',
          'app.searchViaShell',
          'agent.model',
          'agent.provider',
          'agent.reasoningEffort',
          'agent.temperature',
          'agent.useFlexServiceTier',
          'agent.mentorModel',
          'agent.mentorProvider',
          'agent.mentorReasoningEffort',
          'agent.subagentExplorerModel',
          'agent.subagentWorkerModel',
          'agent.subagentResearcherModel',
          'agent.subagentExplorerProvider',
          'agent.subagentWorkerProvider',
          'agent.subagentResearcherProvider',
          'agent.subagentExplorerReasoningEffort',
          'agent.subagentWorkerReasoningEffort',
          'agent.subagentResearcherReasoningEffort',
          'logging.logLevel',
          'logging.suppressConsoleOutput',
          'shell.useRtkCompression',
        ];
        if (rebuildKeys.includes(changedKey)) {
          this.#refreshAgent();
        }
      });

      this.#logger.debug('OpenAI Agent Client initialized', {
        model: model || this.#settings.get<string>('agent.model'),
        reasoningEffort: reasoningEffort ?? 'default',
        temperature: this.#temperature,
        maxTurns: this.#maxTurns,
        retryAttempts: this.#retryAttempts,
      });
    }
  }

  setModel(model: string): void {
    const buildResult = buildAgent({ model, reasoningEffort: this.#reasoningEffort }, this.#buildFactoryDeps());
    this.#agent = buildResult.agent;
    this.#model = buildResult.resolvedModel;
    this.#resetMentorState();
  }

  setReasoningEffort(effort?: ModelSettingsReasoningEffort | 'default'): void {
    this.#reasoningEffort = effort;
    const buildResult = buildAgent({ model: this.#model, reasoningEffort: effort }, this.#buildFactoryDeps());
    this.#agent = buildResult.agent;
    this.#model = buildResult.resolvedModel;
  }

  setTemperature(temperature?: number): void {
    this.#temperature = temperature;
    const buildResult = buildAgent(
      { model: this.#model, reasoningEffort: this.#reasoningEffort, temperature },
      this.#buildFactoryDeps(),
    );
    this.#agent = buildResult.agent;
    this.#model = buildResult.resolvedModel;
  }

  setProvider(provider: string): void {
    this.#provider = provider;
    this.#settings.set('agent.provider', provider);
    const buildResult = buildAgent(
      { model: this.#model, reasoningEffort: this.#reasoningEffort },
      this.#buildFactoryDeps(),
    );
    this.#agent = buildResult.agent;
    this.#model = buildResult.resolvedModel;
    this.#runner = null;
    this.#resetMentorState();
  }

  getProvider(): string {
    return this.#provider;
  }

  getStreamMaxRetries(): number | undefined {
    return this.#settings.get<number | undefined>('agent.streamMaxRetries' as any);
  }

  setAskUserAnswer(callId: string, answer: string): void {
    this.#askUserAnswers.set(callId, answer);
  }

  getAskUserAnswer(callId?: string): string | undefined {
    if (!callId) return undefined;
    const answer = this.#askUserAnswers.get(callId);
    this.#askUserAnswers.delete(callId);
    return answer;
  }

  addToolInterceptor(
    interceptor: (name: string, params: any, toolCallId?: string) => Promise<string | null>,
  ): () => void {
    this.#toolInterceptors.push(interceptor);
    return () => {
      this.#toolInterceptors = this.#toolInterceptors.filter((i) => i !== interceptor);
    };
  }

  async #checkToolInterceptors(name: string, params: any, toolCallId?: string): Promise<string | null> {
    for (const interceptor of this.#toolInterceptors) {
      try {
        const result = await interceptor(name, params, toolCallId);
        if (result !== null) {
          return result;
        }
      } catch (error) {
        this.#logger.error('Tool interceptor threw an error', {
          name,
          params,
          toolCallId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return `Tool execution intercepted but failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return null;
  }

  #buildFactoryDeps(): AgentFactoryDeps {
    return {
      settings: this.#settings,
      logger: this.#logger,
      executionContext: this.#executionContext,
      editor: this.#editor,
      providerId: this.#provider,
      serviceTierOverrideForNextRequest: this.#serviceTierOverrideForNextRequest,
      createMentor: this.#createMentor,
      runSubagent: this.#runSubagent,
      getAskUserAnswer: (callId?: string) => this.getAskUserAnswer(callId),
      checkToolInterceptors: (name, params, toolCallId) => this.#checkToolInterceptors(name, params, toolCallId),
    };
  }

  #getMaxParallelToolCalls(): number {
    const rawValue = this.#settings.get<number | undefined>('agent.maxParallelToolCalls');
    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      return 3;
    }

    return Math.max(1, Math.floor(numericValue));
  }

  #createRunner(providerId: string): Runner | null {
    const providerDef = getProvider(providerId);
    if (!providerDef?.createRunner) {
      return null;
    }

    return providerDef.createRunner({
      settingsService: this.#settings,
      loggingService: this.#logger,
      sessionContextService: this.#sessionContextService,
    });
  }

  #getOrCreateRunner(providerId: string): Runner | null {
    if (providerId !== this.#provider) {
      const runner = this.#createRunner(providerId);
      this.#applyDowngradeCallbackToRunner(runner);
      return runner;
    }

    if (this.#runner) {
      return this.#runner;
    }

    this.#runner = this.#createRunner(providerId);
    this.#applyDowngradeCallbackToRunner(this.#runner);
    return this.#runner;
  }

  setRetryCallback(callback: () => void): void {
    void callback;
  }

  shouldRetryWithoutFlexServiceTier(error: unknown): boolean {
    const useFlexServiceTier = this.#settings.get<boolean>('agent.useFlexServiceTier');
    return (
      useFlexServiceTier &&
      this.#serviceTierOverrideForNextRequest !== 'standard' &&
      (this.#provider === 'openai' || this.#provider === 'openrouter') &&
      isFlexServiceTierTimeout(error)
    );
  }

  useStandardServiceTierForNextRequest(): void {
    this.#serviceTierOverrideForNextRequest = 'standard';
    this.#refreshAgent();
  }

  #refreshAgent(): void {
    if (this.#isTransientClient) return;
    const buildResult = buildAgent(
      { model: this.#model, reasoningEffort: this.#reasoningEffort as any, temperature: this.#temperature },
      this.#buildFactoryDeps(),
    );
    this.#agent = buildResult.agent;
    this.#model = buildResult.resolvedModel;
    // Refreshing core agent should not keep stale mentor state/instructions.
    this.#resetMentorState();
  }

  /**
   * Abort the current running stream/operation
   */
  abort(): void {
    const traceIdBeforeClear = this.#currentCorrelationId ?? this.#logger.getCorrelationId?.();
    if (this.#currentAbortController) {
      this.#currentAbortController.abort();
      this.#currentAbortController = null;
    }
    if (this.#currentCorrelationId) {
      this.#logger.clearCorrelationId();
      this.#currentCorrelationId = null;
    }
    this.#logger.debug('Agent operation aborted', {
      eventType: 'stream.aborted',
      category: 'stream',
      phase: 'abort',
      traceId: traceIdBeforeClear,
    });
  }

  clearConversations(): void {
    const providerDef = getProvider(this.#provider);
    if (providerDef?.clearConversations) {
      providerDef.clearConversations();
    }

    this.#refreshAgent();
    this.#lastChainedDeltaInputItems = null;

    this.#logger.debug('Conversation and agent refreshed');
  }

  #filterAndGuardChainedModelInput(modelData: any, options: ChainedModelInputFilterOptions = {}): any {
    const filtered = filterChainedModelInput(modelData, options);
    const input = filtered?.input;
    if (!Array.isArray(input)) {
      return filtered;
    }

    const previousInputItems = this.#lastChainedDeltaInputItems;
    const inputItems = input.length;
    if (previousInputItems !== null && inputItems - previousInputItems >= 10 && inputItems >= previousInputItems * 3) {
      this.#logger.warn('Chained delta input item count spiked', {
        eventType: 'provider.chained_delta_input_spike',
        category: 'provider',
        phase: 'request_start',
        traceId: this.#logger.getCorrelationId(),
        provider: this.#provider,
        model: this.#model,
        previousInputItems,
        inputItems,
      });
    }

    this.#lastChainedDeltaInputItems = inputItems;
    return filtered;
  }

  async startStream(
    userInput: string | AgentInputItem | AgentInputItem[],
    { previousResponseId, sessionId, toolResultCallIds }: ChainedRunOptions = {},
  ): Promise<any> {
    // Abort any previous operation
    this.abort();

    let agentRefreshed = false;
    // Ensure Codex models are fetched/cached if reasoningEffort is default, so we can apply default_reasoning_level
    if (this.#provider === 'codex' && this.#settings.get<string>('agent.reasoningEffort') === 'default') {
      try {
        await fetchModels({ settingsService: this.#settings, loggingService: this.#logger }, 'codex');
        this.#refreshAgent();
        agentRefreshed = true;
      } catch (err) {
        // ignore
      }
    }

    // Refresh agent instructions for the first message of a session to ensure
    // directory structure and AGENTS.md content are up to date.
    const isFirstMessage =
      !previousResponseId && (!Array.isArray(userInput) || (userInput.length > 0 && userInput.length <= 1));

    if (isFirstMessage && !agentRefreshed) {
      this.#refreshAgent();
    }

    // Create correlation ID for this stream
    this.#currentCorrelationId = randomUUID();
    this.#logger.setCorrelationId(this.#currentCorrelationId);

    this.#currentAbortController = new AbortController();
    const signal = this.#currentAbortController.signal;

    this.#logger.debug('Agent stream started', {
      eventType: 'provider.request.started',
      category: 'provider',
      phase: 'request_start',
      traceId: this.#currentCorrelationId,
      provider: this.#provider,
      model: this.#model,
      inputType: Array.isArray(userInput) ? 'array' : typeof userInput,
      inputLength: typeof userInput === 'string' ? userInput.length : undefined,
      inputItems: Array.isArray(userInput) ? userInput.length : undefined,
      messages: Array.isArray(userInput) ? userInput : undefined,
      hasPreviousResponseId: !!previousResponseId,
    });

    try {
      const userContext: any = {
        turnCount: 0,
        maxTurns: this.#maxTurns,
      };
      const supportsConversationChaining =
        getProvider(this.#provider)?.capabilities?.supportsConversationChaining ?? false;
      const options: any = {
        stream: true,
        maxTurns: this.#maxTurns,
        signal,
        context: userContext,
        toolExecution: { maxFunctionToolConcurrency: this.#getMaxParallelToolCalls() },
        callModelInputFilter: (args: any) => {
          if (args.context) {
            args.context.turnCount = (args.context.turnCount ?? 0) + 1;
          }
          // When WS has degraded to HTTP, server-managed chaining is unavailable;
          // return unfiltered input so the full history reaches the model.
          const currentFallback = this.getFallbackState();
          const chainingActive = supportsConversationChaining && previousResponseId && !currentFallback?.isDowngraded;
          return chainingActive
            ? this.#filterAndGuardChainedModelInput(args.modelData, { toolResultCallIds })
            : args.modelData;
        },
      };
      const agentForRun = this.#getAgentForRun(this.#agent, { sessionId });

      // Only set previousResponseId when chaining is still active (not degraded).
      const currentFallback = this.getFallbackState();
      if (supportsConversationChaining && previousResponseId && !currentFallback?.isDowngraded) {
        options.previousResponseId = previousResponseId;
      }

      const result = await this.#runAgent(agentForRun, userInput, options);
      return result;
    } catch (error: any) {
      this.#logger.error('Agent stream failed', {
        eventType: 'provider.response.failed',
        category: 'provider',
        phase: 'provider_response',
        traceId: this.#currentCorrelationId,
        provider: this.#provider,
        model: this.#model,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        inputType: Array.isArray(userInput) ? 'array' : typeof userInput,
        inputLength: typeof userInput === 'string' ? userInput.length : undefined,
        inputItems: Array.isArray(userInput) ? userInput.length : undefined,
      });
      throw error;
    }
  }

  async continueRun(
    state: any,
    { previousResponseId, sessionId, toolResultCallIds }: ChainedRunOptions = {},
  ): Promise<any> {
    this.abort();
    this.#currentAbortController = new AbortController();
    const signal = this.#currentAbortController.signal;

    let userContext: any;
    if (state && state._context) {
      userContext = state._context.context;
      if (!userContext) {
        userContext = {};
        state._context.context = userContext;
      }
    } else {
      userContext = {
        turnCount: 0,
      };
    }
    userContext.maxTurns = this.#maxTurns;
    if (typeof userContext.turnCount !== 'number') {
      userContext.turnCount = 0;
    }

    const supportsConversationChaining =
      getProvider(this.#provider)?.capabilities?.supportsConversationChaining ?? false;
    const options: any = {
      signal,
      context: userContext,
      toolExecution: { maxFunctionToolConcurrency: this.#getMaxParallelToolCalls() },
      callModelInputFilter: (args: any) => {
        if (args.context) {
          args.context.turnCount = (args.context.turnCount ?? 0) + 1;
        }
        const currentFallback = this.getFallbackState();
        const chainingActive = supportsConversationChaining && previousResponseId && !currentFallback?.isDowngraded;
        return chainingActive
          ? this.#filterAndGuardChainedModelInput(args.modelData, { toolResultCallIds })
          : args.modelData;
      },
    };
    const agentForRun = this.#getAgentForRun(this.#agent, { sessionId });

    const currentFallback = this.getFallbackState();
    if (supportsConversationChaining && previousResponseId && !currentFallback?.isDowngraded) {
      options.previousResponseId = previousResponseId;
    }

    return this.#runAgent(agentForRun, state, options);
  }

  async continueRunStream(
    state: any,
    { previousResponseId, sessionId, toolResultCallIds }: ChainedRunOptions = {},
  ): Promise<any> {
    this.abort();
    this.#currentAbortController = new AbortController();
    const signal = this.#currentAbortController.signal;

    let userContext: any;
    if (state && state._context) {
      userContext = state._context.context;
      if (!userContext) {
        userContext = {};
        state._context.context = userContext;
      }
    } else {
      userContext = {
        turnCount: 0,
      };
    }
    userContext.maxTurns = this.#maxTurns;
    if (typeof userContext.turnCount !== 'number') {
      userContext.turnCount = 0;
    }

    const supportsConversationChaining =
      getProvider(this.#provider)?.capabilities?.supportsConversationChaining ?? false;
    const options: any = {
      stream: true,
      maxTurns: this.#maxTurns,
      signal,
      context: userContext,
      toolExecution: { maxFunctionToolConcurrency: this.#getMaxParallelToolCalls() },
      callModelInputFilter: (args: any) => {
        if (args.context) {
          args.context.turnCount = (args.context.turnCount ?? 0) + 1;
        }
        const currentFallback = this.getFallbackState();
        const chainingActive = supportsConversationChaining && previousResponseId && !currentFallback?.isDowngraded;
        return chainingActive
          ? this.#filterAndGuardChainedModelInput(args.modelData, { toolResultCallIds })
          : args.modelData;
      },
    };
    const agentForRun = this.#getAgentForRun(this.#agent, { sessionId });

    const currentFallback = this.getFallbackState();
    if (supportsConversationChaining && previousResponseId && !currentFallback?.isDowngraded) {
      options.previousResponseId = previousResponseId;
    }

    return this.#runAgent(agentForRun, state, options);
  }

  #runAgentWithProvider(
    providerId: string,
    runner: Runner | null,
    agent: Agent<any, any>,
    input: any,
    options: any,
  ): Promise<any> {
    // The Agents SDK enables tracing by default and exports spans to OpenAI.
    // When using non-OpenAI providers (e.g., OpenRouter), this export can fail noisily
    // (e.g., 503 errors). Disable tracing per-run for any non-OpenAI provider.
    const effectiveOptions: any = options ? { ...options } : {};
    const supportsTracingControl = getProvider(providerId)?.capabilities?.supportsTracingControl ?? false;
    if (!supportsTracingControl) {
      effectiveOptions.tracingDisabled = true;
    }

    // Check if provider is configured but runner failed to initialize
    if (!runner && providerId !== 'openai') {
      const providerDef = getProvider(providerId);
      const providerLabel = providerDef?.label || providerId;
      throw new Error(
        `${providerLabel} is configured but could not be initialized. ` +
          `Please check that all required credentials and provider settings are set.`,
      );
    }

    // Use runner if available (custom provider), otherwise use run() directly (OpenAI)
    if (runner) {
      return runner.run(agent, input, effectiveOptions);
    }
    return run(agent, input, effectiveOptions);
  }

  async #runAgent(agent: Agent, input: any, options: any): Promise<any> {
    const shouldResetServiceTierOverride = this.#serviceTierOverrideForNextRequest === 'standard';
    try {
      return await this.#runAgentWithProvider(
        this.#provider,
        this.#getOrCreateRunner(this.#provider),
        agent,
        input,
        options,
      );
    } finally {
      if (shouldResetServiceTierOverride) {
        this.#serviceTierOverrideForNextRequest = null;
        this.#refreshAgent();
      }
    }
  }

  async chat(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ModelSettingsReasoningEffort | 'default';
      instructions?: string;
    } = {},
  ): Promise<string> {
    const tempProvider = options.provider || this.#provider;
    this.#logger.debug('Agent chat request', {
      messageLength: message.length,
      model: options.model || this.#model,
      provider: tempProvider,
    });

    const isDefaultSetting = this.#settings.get<string>('agent.reasoningEffort') === 'default';
    if (tempProvider === 'codex' && isDefaultSetting) {
      try {
        await fetchModels({ settingsService: this.#settings, loggingService: this.#logger }, 'codex');
        this.#refreshAgent();
      } catch (err) {
        // ignore
      }
    }

    try {
      // Create a temporary agent for this specific chat request if params differ
      let agentForChat = this.#agent;
      const tempModel = options.model || this.#model;
      const tempEffort = options.reasoningEffort || this.#reasoningEffort;

      if (options.model || options.reasoningEffort || options.instructions || options.provider) {
        const modelSettings: any = {};

        let effectiveEffort = tempEffort;
        if (tempProvider === 'codex' && isDefaultSetting && (!effectiveEffort || effectiveEffort === 'default')) {
          const defaultReasoningLevel = getModelDefaultReasoningLevel('codex', tempModel);
          if (defaultReasoningLevel) {
            effectiveEffort = defaultReasoningLevel as ModelSettingsReasoningEffort;
          }
        }

        if (effectiveEffort && effectiveEffort !== 'default') {
          modelSettings.reasoning = {
            effort: effectiveEffort,
            summary: 'auto',
          };
        }

        // For simple chat, we generally don't need tools, but we keep the system instructions
        agentForChat = new Agent({
          name: 'Chat',
          model: tempModel,
          ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
          instructions: options.instructions || 'You are a helpful assistant.',
        });
      }

      // If provider is different from main provider, we need a separate runner
      const runnerForChat = this.#getOrCreateRunner(tempProvider);

      // We use a simplified run flow for chat
      const result = await this.#runAgentWithProvider(tempProvider, runnerForChat, agentForChat, message, {
        stream: false,
        maxTurns: 1, // Chat is usually single turn
      });

      return this.#extractResponse(result);
    } catch (error) {
      this.#logger.error('Agent chat failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error; // Propagate error
    }
  }

  async chatJson(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ModelSettingsReasoningEffort | 'default';
      instructions?: string;
      outputType: JsonSchemaDefinition;
    },
  ): Promise<unknown> {
    const tempProvider = options.provider || this.#provider;
    this.#logger.debug('Agent structured chat request', {
      messageLength: message.length,
      model: options.model || this.#model,
      provider: tempProvider,
    });

    const isDefaultSetting = this.#settings.get<string>('agent.reasoningEffort') === 'default';
    if (tempProvider === 'codex' && isDefaultSetting) {
      try {
        await fetchModels({ settingsService: this.#settings, loggingService: this.#logger }, 'codex');
        this.#refreshAgent();
      } catch (err) {
        // ignore
      }
    }

    try {
      const tempModel = options.model || this.#model;
      const tempEffort = options.reasoningEffort || this.#reasoningEffort;
      const modelSettings: any = {};

      let effectiveEffort = tempEffort;
      if (tempProvider === 'codex' && isDefaultSetting && (!effectiveEffort || effectiveEffort === 'default')) {
        const defaultReasoningLevel = getModelDefaultReasoningLevel('codex', tempModel);
        if (defaultReasoningLevel) {
          effectiveEffort = defaultReasoningLevel as ModelSettingsReasoningEffort;
        }
      }

      if (effectiveEffort && effectiveEffort !== 'default') {
        modelSettings.reasoning = {
          effort: effectiveEffort,
          summary: 'auto',
        };
      }

      const agentForChat = new Agent({
        name: 'Chat',
        model: tempModel,
        ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
        instructions: options.instructions || 'You are a helpful assistant.',
        outputType: options.outputType,
      });

      const runnerForChat = this.#getOrCreateRunner(tempProvider);

      const result = await this.#runAgentWithProvider(tempProvider, runnerForChat, agentForChat, message, {
        stream: false,
        maxTurns: 1,
      });

      return result.finalOutput ?? this.#extractResponse(result);
    } catch (error) {
      this.#logger.error('Agent structured chat failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  #extractResponse(result: any): string {
    if (result.finalOutput) {
      return result.finalOutput;
    }

    // Fallback: extract from messages if finalOutput is missing
    if (result.messages && Array.isArray(result.messages)) {
      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage && lastMessage.content) {
        if (typeof lastMessage.content === 'string') {
          return lastMessage.content;
        }
        if (Array.isArray(lastMessage.content)) {
          return lastMessage.content.map((part: any) => part.text || part.value || '').join('');
        }
      }
    }

    return '';
  }

  #getAgentForRun(agent: Agent, { sessionId }: { sessionId?: string } = {}): Agent {
    const supportsPromptCacheKey = getProvider(this.#provider)?.capabilities?.supportsPromptCacheKey;
    if (!supportsPromptCacheKey || !sessionId) {
      return agent;
    }

    return agent.clone({
      modelSettings: {
        ...(agent.modelSettings || {}),
        prompt_cache_key: sessionId,
      } as any,
    });
  }

  #createMentor = async (question: string): Promise<string> => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot spawn subagents.');
    }
    this.#activeSubagentsCount++;
    try {
      const result = await this.#subagentManager.run({ role: 'mentor', task: question, parentTool: 'ask_mentor' });
      if (result.status === 'failed') {
        throw new Error(result.error || 'Mentor consultation failed');
      }
      return result.finalText;
    } catch (error) {
      this.#logger.error('Mentor consultation failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    } finally {
      this.#activeSubagentsCount--;
      if (this.#activeSubagentsCount === 0 && this.#pendingClearSink) {
        this.#subagentEventSink = null;
        this.#pendingClearSink = false;
      }
    }
  };

  #runSubagent = async (
    params: { role: string; task: string },
    _context?: unknown,
    details?: unknown,
  ): Promise<any> => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot spawn subagents.');
    }
    // Forward any resumeState from the SDK (populated in the Agent.asTool
    // path) to the subagent manager so it can restore the agent run state
    // for nested approval continuation.
    const detailsRecord = details as { resumeState?: string; signal?: AbortSignal; toolCall?: unknown } | undefined;
    const request = {
      ...params,
      parentTool: 'run_subagent',
      ...(detailsRecord?.resumeState ? { resumeState: detailsRecord.resumeState } : {}),
      ...(detailsRecord?.signal ? { signal: detailsRecord.signal } : {}),
    };

    this.#activeSubagentsCount++;
    try {
      const result = await this.#subagentManager.run(request);

      // saveAgentToolRunResult is not exported as a public API from
      // @openai/agents-core, so we cannot call it here. The nestedRunResult
      // is preserved on the SubagentResult for use by the caller and will
      // be propagated back through the conversation result builder when the
      // run_subagent is registered via Agent.asTool (future work).

      return result;
    } finally {
      this.#activeSubagentsCount--;
      if (this.#activeSubagentsCount === 0 && this.#pendingClearSink) {
        this.#subagentEventSink = null;
        this.#pendingClearSink = false;
      }
    }
  };

  getSettings(): ISettingsService {
    return this.#settings;
  }
}
