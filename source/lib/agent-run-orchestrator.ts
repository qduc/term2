import { Agent, run, type AgentInputItem, Runner, type RunState, type StreamedRunResult } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { getProvider } from '../providers/index.js';
import { fetchModels } from '../services/model-service.js';
import { filterChainedModelInput, type ChainedModelInputFilterOptions } from './chained-input-filter.js';
import { AgentConfiguration } from './agent-configuration.js';
import { RunnerManager } from './runner-manager.js';
import type { ProviderHistorySnapshot } from '../services/conversation/conversation-store.js';
import {
  projectOpenAIChainedModelInput,
  type OpenAIChainedInputCompatibilityProjection,
} from '../providers/openai-chained-input-compatibility.js';
import {
  prepareOpenAIRequestPrefixBinding,
  runWithOpenAIRequestPrefixBindingScope,
} from '../providers/openai-request-prefix-binding.js';
import type { ContinuationProjectionMode } from './continuation-projection-mode.js';

type ChainedRunOptions = {
  previousResponseId?: string | null;
  sessionId?: string;
  toolResultCallIds?: readonly string[];
  knownToolCallIds?: readonly string[];
  providerHistorySnapshot?: ProviderHistorySnapshot;
};

export type OpenAIChainedInputParityObservation = {
  baseline: OpenAIChainedInputCompatibilityProjection;
  compatibility: OpenAIChainedInputCompatibilityProjection;
  matches: boolean;
};

export type OpenAIChainedInputParityObserver = {
  record(observation: OpenAIChainedInputParityObservation): void;
};

export interface AgentRunOrchestratorDeps {
  agentConfig: AgentConfiguration;
  runnerManager: RunnerManager;
  settings: ISettingsService;
  logger: ILoggingService;
  continuationProjectionMode?: ContinuationProjectionMode;
  openAIChainedInputParityObserver?: OpenAIChainedInputParityObserver;
  openAIChainedInputProjector?: typeof projectOpenAIChainedModelInput;
}

/**
 * Owns the stream/run lifecycle for an AgentClient.
 *
 * Responsibilities:
 * - Stream lifecycle: startStream(), continueRunStream()
 * - Abort: abort()
 * - Conversation state: clearConversations(), supportsConversationChaining()
 * - Internal: #runAgent(), #runAgentWithProvider(), #filterAndGuardChainedModelInput(), #getMaxParallelToolCalls()
 */
export class AgentRunOrchestrator {
  #currentAbortController: AbortController | null = null;
  #currentCorrelationId: string | null = null;
  #lastChainedDeltaInputItems: number | null = null;

  #agentConfig: AgentConfiguration;
  #runnerManager: RunnerManager;
  #settings: ISettingsService;
  #logger: ILoggingService;
  #continuationProjectionMode: ContinuationProjectionMode;
  #openAIChainedInputParityObserver?: OpenAIChainedInputParityObserver;
  #openAIChainedInputProjector: typeof projectOpenAIChainedModelInput;

  constructor(deps: AgentRunOrchestratorDeps) {
    this.#agentConfig = deps.agentConfig;
    this.#runnerManager = deps.runnerManager;
    this.#settings = deps.settings;
    this.#logger = deps.logger;
    this.#continuationProjectionMode = deps.continuationProjectionMode ?? 'legacy';
    this.#openAIChainedInputParityObserver = deps.openAIChainedInputParityObserver;
    this.#openAIChainedInputProjector = deps.openAIChainedInputProjector ?? projectOpenAIChainedModelInput;
  }

  supportsConversationChaining(): boolean {
    const providerSupportsChaining =
      getProvider(this.#agentConfig.getProvider())?.capabilities?.supportsConversationChaining ?? false;
    if (
      (this.#agentConfig.getProvider() === 'openai' || this.#agentConfig.getProvider() === 'codex') &&
      this.#settings.get('agent.transport') === 'http'
    ) {
      return false;
    }
    return providerSupportsChaining;
  }

  #getMaxParallelToolCalls(): number {
    const rawValue = this.#settings.get<number | undefined>('agent.maxParallelToolCalls');
    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      return 3;
    }

    return Math.max(1, Math.floor(numericValue));
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
    const providerDef = getProvider(this.#agentConfig.getProvider());
    if (providerDef?.clearConversations) {
      providerDef.clearConversations();
    }

    this.#agentConfig.refreshAgent();
    this.#lastChainedDeltaInputItems = null;

    this.#logger.debug('Conversation and agent refreshed');
  }

  #filterAndGuardChainedModelInput(
    modelData: any,
    options: ChainedModelInputFilterOptions = {},
    providerHistorySnapshot?: ProviderHistorySnapshot,
    previousResponseId?: string | null,
  ): any {
    let filtered: any;
    let baseline: OpenAIChainedInputCompatibilityProjection;
    try {
      filtered = filterChainedModelInput(modelData, options);
      baseline = {
        prefix: this.#unanchoredPrefix(providerHistorySnapshot, modelData),
        projectedModelData: filtered,
        projectedInput: filtered?.input,
      };
    } catch (error) {
      baseline = {
        prefix: this.#unanchoredPrefix(providerHistorySnapshot, modelData),
        error: this.#errorProjection(error),
      };
      this.#observeOpenAICompatibilityParity(modelData, options, providerHistorySnapshot, previousResponseId, baseline);
      throw error;
    }
    const compatibility = this.#observeOpenAICompatibilityParity(
      modelData,
      options,
      providerHistorySnapshot,
      previousResponseId,
      baseline,
    );
    this.#prepareOpenAIRequestPrefixBinding(compatibility, providerHistorySnapshot);
    if (this.#selectCompatibleOpenAIProjection(compatibility, providerHistorySnapshot, baseline)) {
      filtered = compatibility.projectedModelData;
    }
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
        provider: this.#agentConfig.getProvider(),
        model: this.#agentConfig.getModel(),
        previousInputItems,
        inputItems,
      });
    }

    this.#lastChainedDeltaInputItems = inputItems;
    return filtered;
  }

  #unanchoredPrefix(
    snapshot: ProviderHistorySnapshot | undefined,
    modelData: any,
  ): OpenAIChainedInputCompatibilityProjection['prefix'] {
    const input = Array.isArray(modelData?.input) ? modelData.input : [];
    return {
      kind: 'mismatch',
      snapshotIdentity: snapshot?.identity ?? 'unavailable',
      snapshotItemCount: snapshot?.history.length ?? 0,
      modelInputItemCount: input.length,
      matchedPrefixItems: 0,
      mismatchIndex: 0,
    };
  }

  #errorProjection(error: unknown): { name: string; message: string; callIds?: readonly string[] } {
    const value = error as { name?: unknown; message?: unknown; callIds?: unknown };
    return {
      name: typeof value?.name === 'string' ? value.name : 'Error',
      message: typeof value?.message === 'string' ? value.message : String(error),
      ...(Array.isArray(value?.callIds) ? { callIds: value.callIds as string[] } : {}),
    };
  }

  #observeOpenAICompatibilityParity(
    modelData: any,
    options: ChainedModelInputFilterOptions,
    snapshot: ProviderHistorySnapshot | undefined,
    previousResponseId: string | null | undefined,
    baseline: OpenAIChainedInputCompatibilityProjection,
  ): OpenAIChainedInputCompatibilityProjection | undefined {
    if (this.#agentConfig.getProvider() !== 'openai' || !snapshot) return undefined;
    try {
      const compatibility = this.#openAIChainedInputProjector(snapshot, modelData, { ...options, previousResponseId });
      const observation: OpenAIChainedInputParityObservation = {
        baseline,
        compatibility,
        matches:
          isDeepStrictEqual(baseline.projectedModelData, compatibility.projectedModelData) &&
          isDeepStrictEqual(baseline.error, compatibility.error),
      };
      this.#openAIChainedInputParityObserver?.record(observation);
      return compatibility;
    } catch {
      // Parity observation is diagnostic only; it must never affect the SDK request.
      return undefined;
    }
  }

  #selectCompatibleOpenAIProjection(
    compatibility: OpenAIChainedInputCompatibilityProjection | undefined,
    snapshot: ProviderHistorySnapshot | undefined,
    baseline: OpenAIChainedInputCompatibilityProjection,
  ): compatibility is OpenAIChainedInputCompatibilityProjection & { projectedModelData: any } {
    if (
      this.#continuationProjectionMode !== 'openai-provider' ||
      this.#agentConfig.getProvider() !== 'openai' ||
      !snapshot ||
      !compatibility
    ) {
      return false;
    }
    return (
      compatibility.prefix.kind === 'match' &&
      isDeepStrictEqual(baseline.projectedModelData, compatibility.projectedModelData) &&
      isDeepStrictEqual(baseline.error, compatibility.error)
    );
  }

  #prepareOpenAIRequestPrefixBinding(
    compatibility: OpenAIChainedInputCompatibilityProjection | undefined,
    snapshot: ProviderHistorySnapshot | undefined,
  ): void {
    if (
      this.#agentConfig.getProvider() !== 'openai' ||
      !snapshot ||
      compatibility?.prefix.kind !== 'match' ||
      compatibility.projectedInput === undefined
    ) {
      return;
    }
    prepareOpenAIRequestPrefixBinding(
      { snapshotIdentity: snapshot.identity, snapshotRevision: snapshot.revision },
      compatibility.projectedInput,
    );
  }

  async startStream(
    userInput: string | AgentInputItem | AgentInputItem[],
    {
      previousResponseId,
      sessionId,
      toolResultCallIds,
      knownToolCallIds,
      providerHistorySnapshot,
    }: ChainedRunOptions = {},
  ): Promise<StreamedRunResult<any, any>> {
    // Abort any previous operation
    this.abort();

    let agentRefreshed = false;
    // Ensure Codex models are fetched/cached if reasoningEffort is default, so we can apply default_reasoning_level
    if (
      this.#agentConfig.getProvider() === 'codex' &&
      this.#settings.get<string>('agent.reasoningEffort') === 'default'
    ) {
      try {
        await fetchModels({ settingsService: this.#settings, loggingService: this.#logger }, 'codex');
        this.#agentConfig.refreshAgent();
        agentRefreshed = true;
      } catch (_err) {
        // ignore
      }
    }

    // Refresh agent instructions for the first message of a session to ensure
    // directory structure and AGENTS.md content are up to date.
    const isFirstMessage =
      !previousResponseId && (!Array.isArray(userInput) || (userInput.length > 0 && userInput.length <= 1));

    if (isFirstMessage && !agentRefreshed) {
      this.#agentConfig.refreshAgent();
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
      provider: this.#agentConfig.getProvider(),
      model: this.#agentConfig.getModel(),
      inputType: Array.isArray(userInput) ? 'array' : typeof userInput,
      inputLength: typeof userInput === 'string' ? userInput.length : undefined,
      inputItems: Array.isArray(userInput) ? userInput.length : undefined,
      messages: Array.isArray(userInput) ? userInput : undefined,
      hasPreviousResponseId: !!previousResponseId,
    });

    try {
      const userContext: any = {
        turnCount: 0,
        maxTurns: this.#runnerManager.maxTurns,
        ...(sessionId ? { sessionId } : {}),
      };
      const supportsConversationChaining = this.supportsConversationChaining();
      const options: any = {
        stream: true,
        maxTurns: this.#runnerManager.maxTurns,
        signal,
        context: userContext,
        toolExecution: { maxFunctionToolConcurrency: this.#getMaxParallelToolCalls() },
        callModelInputFilter: (args: any) => {
          if (args.context) {
            args.context.turnCount = (args.context.turnCount ?? 0) + 1;
          }
          const chainingActive = supportsConversationChaining && previousResponseId;
          return chainingActive
            ? this.#filterAndGuardChainedModelInput(
                args.modelData,
                { toolResultCallIds, knownToolCallIds },
                providerHistorySnapshot,
                previousResponseId,
              )
            : args.modelData;
        },
      };
      const agentForRun = this.#agentConfig.getAgent(sessionId);

      if (supportsConversationChaining && previousResponseId) {
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
        provider: this.#agentConfig.getProvider(),
        model: this.#agentConfig.getModel(),
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        inputType: Array.isArray(userInput) ? 'array' : typeof userInput,
        inputLength: typeof userInput === 'string' ? userInput.length : undefined,
        inputItems: Array.isArray(userInput) ? userInput.length : undefined,
      });
      throw error;
    }
  }

  async continueRunStream(
    state: RunState<any, any>,
    {
      previousResponseId,
      sessionId,
      toolResultCallIds,
      knownToolCallIds,
      providerHistorySnapshot,
    }: ChainedRunOptions = {},
  ): Promise<StreamedRunResult<any, any>> {
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
    userContext.maxTurns = this.#runnerManager.maxTurns;
    if (sessionId) {
      userContext.sessionId = sessionId;
    }
    if (typeof userContext.turnCount !== 'number') {
      userContext.turnCount = 0;
    }

    const supportsConversationChaining = this.supportsConversationChaining();
    const options: any = {
      stream: true,
      maxTurns: this.#runnerManager.maxTurns,
      signal,
      context: userContext,
      toolExecution: { maxFunctionToolConcurrency: this.#getMaxParallelToolCalls() },
      callModelInputFilter: (args: any) => {
        if (args.context) {
          args.context.turnCount = (args.context.turnCount ?? 0) + 1;
        }
        const chainingActive = supportsConversationChaining && previousResponseId;
        return chainingActive
          ? this.#filterAndGuardChainedModelInput(
              args.modelData,
              { toolResultCallIds, knownToolCallIds },
              providerHistorySnapshot,
              previousResponseId,
            )
          : args.modelData;
      },
    };
    const agentForRun = this.#agentConfig.getAgent(sessionId);

    if (supportsConversationChaining && previousResponseId) {
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
    const shouldResetServiceTierOverride = this.#agentConfig.serviceTierOverrideForNextRequest === 'standard';
    try {
      const providerId = this.#agentConfig.getProvider();
      const runAgent = () =>
        this.#runAgentWithProvider(
          providerId,
          this.#runnerManager.getOrCreateRunner(providerId),
          agent,
          input,
          options,
        );
      return await (providerId === 'openai' ? runWithOpenAIRequestPrefixBindingScope(runAgent) : runAgent());
    } finally {
      if (shouldResetServiceTierOverride) {
        this.#agentConfig.serviceTierOverrideForNextRequest = null;
        this.#agentConfig.refreshAgent();
      }
    }
  }
}
