import {
  Agent,
  run,
  tool as createTool,
  applyPatchTool,
  type Tool,
  type AgentInputItem,
  Runner,
  type JsonSchemaDefinition,
} from '@openai/agents';
import { getProvider } from '../providers/index.js';
import { type FallbackState } from '../providers/fallback-responses-model.js';
import type { ModelProvider } from '@openai/agents-core/model';
import { type ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import { randomUUID } from 'node:crypto';
import { getAgentDefinition } from '../agent.js';
import { z } from 'zod';
import { normalizeObjectParams, normalizeToolInput, toolErrorFunction, wrapToolInvoke } from './tool-invoke.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import { ExecutionContext } from '../services/execution-context.js';
import { createEditorImpl } from './editor-impl.js';
import { trimToolOutput } from '../utils/trim-tool-output.js';
import { injectWarningIntoToolOutput } from '../utils/inject-warning-into-tool-output.js';
import { toOpenAIStrictToolSchema } from './openai-strict-tool-schema.js';
import { executeWithRetry } from './retry-executor.js';
import { shouldUseNativePatchTool, shouldUseStrictToolSchema } from './tool-selection-policy.js';
import { isFlexServiceTierTimeout } from '../utils/flex-service-tier.js';
import { SubagentManager } from '../services/subagents/subagent-manager.js';
import type { ConversationEvent } from '../services/conversation-events.js';
import { fetchModels, getModelDefaultReasoningLevel } from '../services/model-service.js';

const TOOL_RESULT_ITEM_TYPES = new Set([
  'function_call_output',
  'function_call_result',
  'function_call_output_result',
  'tool_call_output',
  'tool_call_result',
  'tool_call_output_item',
  'local_shell_call_output',
  'shell_call_output',
  'computer_call_output',
  'computer_call_result',
  'apply_patch_call_output',
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const isUserInputMessage = (item: unknown): boolean => {
  const record = asRecord(item);
  return record?.role === 'user';
};

const isToolResultItem = (item: unknown): boolean => {
  const record = asRecord(item);
  return typeof record?.type === 'string' && TOOL_RESULT_ITEM_TYPES.has(record.type);
};

const getToolResultCallId = (item: unknown): string | null => {
  const record = asRecord(item);
  if (!record || !isToolResultItem(record)) {
    return null;
  }

  const raw = asRecord(record.rawItem) ?? record;
  const callId = raw.callId ?? raw.call_id ?? raw.tool_call_id;
  return typeof callId === 'string' && callId ? callId : null;
};

type ChainedModelInputFilterOptions = {
  toolResultCallIds?: readonly string[];
};

type ChainedRunOptions = {
  previousResponseId?: string | null;
  sessionId?: string;
  toolResultCallIds?: readonly string[];
};

/**
 * Finds the starting index of the delta input when conversation chaining is active.
 *
 * Assumption: Deltas are expected to be either:
 *  (a) trailing tool results (when the model has just called tools and is continuing), or
 *  (b) a new user message plus everything after it (when starting a new turn).
 *
 * If the input ends with a replayed assistant message that follows a tool output,
 * this function falls back to searching for the last user message, which may over-retain.
 * In practice, this is rare because model invocations are typically triggered by new user
 * inputs or new tool results.
 */
const findChainedDeltaStart = (input: unknown[]): number => {
  let trailingToolResultStart = input.length;
  while (trailingToolResultStart > 0 && isToolResultItem(input[trailingToolResultStart - 1])) {
    trailingToolResultStart--;
  }
  if (trailingToolResultStart < input.length) {
    return trailingToolResultStart;
  }

  for (let index = input.length - 1; index >= 0; index--) {
    if (isUserInputMessage(input[index])) {
      return index;
    }
  }

  return 0;
};

const filterChainedModelInput = (modelData: any, options: ChainedModelInputFilterOptions = {}): any => {
  const input = modelData?.input;
  if (!Array.isArray(input) || input.length <= 1) {
    return modelData;
  }

  const expectedToolResultCallIds = new Set(options.toolResultCallIds?.filter(Boolean) ?? []);
  if (expectedToolResultCallIds.size > 0) {
    const expectedToolResults = input.filter((item) => {
      const callId = getToolResultCallId(item);
      return callId !== null && expectedToolResultCallIds.has(callId);
    });

    if (expectedToolResults.length > 0) {
      return {
        ...modelData,
        input: expectedToolResults,
      };
    }
  }

  const deltaStart = findChainedDeltaStart(input);
  if (deltaStart <= 0) {
    return modelData;
  }

  return {
    ...modelData,
    input: input.slice(deltaStart),
  };
};

/**
 * Wraps a tool definition's needsApproval so that structurally invalid params
 * (those that fail Zod schema validation) never trigger an approval prompt.
 * The tool's execute will receive those params and return a structured error.
 *
 * Params are normalised using schema-aware coercion before validation:
 *  1. Null sentinels (null, "null", "None", "") on optional fields → omitted
 *  2. Boolean strings ("true"/"false") on boolean fields → true/false
 *  3. Stringified JSON arrays/objects on typed fields → parsed values
 *
 * This handles the OpenAI strict-schema convention where omitted optional fields
 * arrive as null, as well as models that stringify structured parameters.
 */
export function wrapNeedsApproval(
  definition: {
    parameters: { safeParse: (v: unknown) => { success: boolean } };
    needsApproval: (params: unknown, context?: unknown) => Promise<boolean> | boolean;
  },
  options?: {
    // When an interceptor (e.g. plan mode) would reject this call, the approval
    // prompt must be suppressed — execute() returns the rejection to the model.
    checkInterceptors?: (params: unknown) => Promise<string | null>;
  },
): (context: unknown, params: unknown) => Promise<boolean> {
  return async (context, params) => {
    if (options?.checkInterceptors) {
      try {
        const rejectionMessage = await options.checkInterceptors(params);
        if (rejectionMessage) {
          return false;
        }
      } catch {
        // If the interceptor check throws, fall through to normal approval
        // logic rather than silently skipping the prompt.
      }
    }

    // Apply schema-aware normalisation directly on the object (no JSON round-trip).
    // Falls back to a minimal null→undefined pass if the schema is unavailable
    // or normalisation itself throws.
    let normalized: unknown;
    try {
      normalized = normalizeObjectParams(params, definition.parameters as z.ZodTypeAny);
    } catch {
      normalized =
        params !== null && typeof params === 'object' && !Array.isArray(params)
          ? Object.fromEntries(
              Object.entries(params as Record<string, unknown>).map(([k, v]) => [k, v === null ? undefined : v]),
            )
          : params;
    }

    if (!definition.parameters.safeParse(normalized).success) {
      return false;
    }
    try {
      return await definition.needsApproval(normalized, context);
    } catch (error) {
      // If needsApproval throws, fail-safe to requiring approval
      return true;
    }
  };
}

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
  #retryCallback: (() => void) | null = null;
  #runner: Runner | null = null;

  #serviceTierOverrideForNextRequest: 'standard' | null = null;
  #toolInterceptors: ((name: string, params: any, toolCallId?: string) => Promise<string | null>)[] = [];
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #executionContext?: ExecutionContext;
  #editor: ReturnType<typeof createEditorImpl>;
  #subagentManager: SubagentManager;
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
    this.#subagentManager.resetMentorSession();
  }

  constructor({
    model,
    reasoningEffort,
    maxTurns,
    retryAttempts,
    deps,
  }: {
    model?: string;
    reasoningEffort?: ModelSettingsReasoningEffort | 'default';
    maxTurns?: number;
    retryAttempts?: number;
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
    this.#subagentManager = new SubagentManager({
      logger: deps.logger,
      settings: deps.settings,
      executionContext: deps.executionContext,
      sessionContextService: this.#sessionContextService,
      onEvent: (event) => this.#subagentEventSink?.(event),
      agentClient: { chat: (message, options) => this.chat(message, options) },
    });
    this.#editor = createEditorImpl({
      loggingService: this.#logger,
      settingsService: this.#settings,
      executionContext: this.#executionContext,
    });
    this.#reasoningEffort = reasoningEffort;
    this.#temperature = this.#settings.get<number | undefined>('agent.temperature');
    this.#provider = this.#settings.get<string>('agent.provider') || 'openai';
    this.#maxTurns = maxTurns ?? 20;
    this.#retryAttempts = retryAttempts ?? 2;
    this.#agent = this.#createAgent({ model, reasoningEffort });
    this.#runner = null;

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

  setModel(model: string): void {
    this.#agent = this.#createAgent({
      model,
      reasoningEffort: this.#reasoningEffort,
    });
    this.#resetMentorState();
  }

  setReasoningEffort(effort?: ModelSettingsReasoningEffort | 'default'): void {
    this.#reasoningEffort = effort;
    this.#agent = this.#createAgent({
      model: this.#model,
      reasoningEffort: effort,
    });
  }

  setTemperature(temperature?: number): void {
    this.#temperature = temperature;
    this.#agent = this.#createAgent({
      model: this.#model,
      reasoningEffort: this.#reasoningEffort,
      temperature,
    });
  }

  setProvider(provider: string): void {
    this.#provider = provider;
    this.#settings.set('agent.provider', provider);
    this.#agent = this.#createAgent({
      model: this.#model,
      reasoningEffort: this.#reasoningEffort,
    });
    this.#runner = null;
    this.#resetMentorState();
  }

  getProvider(): string {
    return this.#provider;
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

  #getMaxParallelToolCalls(): number {
    const rawValue = this.#settings.get<number | undefined>('agent.maxParallelToolCalls');
    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      return 3;
    }

    return Math.max(1, Math.floor(numericValue));
  }

  #getProviderCapabilities(providerId: string): {
    supportsConversationChaining: boolean;
    supportsTracingControl: boolean;
    supportsPromptCacheKey?: boolean;
    usesStrictToolSchema?: boolean;
    nativePatchModelPrefixes?: string[];
  } {
    const providerDef = getProvider(providerId);
    return {
      supportsConversationChaining: providerDef?.capabilities?.supportsConversationChaining ?? false,
      supportsTracingControl: providerDef?.capabilities?.supportsTracingControl ?? false,
      supportsPromptCacheKey: providerDef?.capabilities?.supportsPromptCacheKey,
      usesStrictToolSchema: providerDef?.capabilities?.usesStrictToolSchema,
      nativePatchModelPrefixes: providerDef?.capabilities?.nativePatchModelPrefixes,
    };
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
    this.#retryCallback = callback;
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
    this.#agent = this.#createAgent({
      model: this.#model,
      reasoningEffort: this.#reasoningEffort as any,
      temperature: this.#temperature,
    });
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
      const { supportsConversationChaining } = this.#getProviderCapabilities(this.#provider);
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

      const result = await this.#executeWithRetry(() => this.#runAgent(agentForRun, userInput, options));
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

    const { supportsConversationChaining } = this.#getProviderCapabilities(this.#provider);
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

    return this.#executeWithRetry(() => this.#runAgent(agentForRun, state, options));
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

    const { supportsConversationChaining } = this.#getProviderCapabilities(this.#provider);
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

    return this.#executeWithRetry(() => this.#runAgent(agentForRun, state, options));
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
    const { supportsTracingControl } = this.#getProviderCapabilities(providerId);
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

  async #executeWithRetry<T>(operation: () => Promise<T>, retries = this.#retryAttempts): Promise<T> {
    return executeWithRetry({
      operation,
      retryAttempts: retries,
      provider: this.#provider,
      model: this.#model,
      traceId: this.#currentCorrelationId,
      logger: this.#logger,
      onRetry: this.#retryCallback ?? undefined,
    });
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
    const { supportsPromptCacheKey } = this.#getProviderCapabilities(this.#provider);
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

  #createAgent({
    model,
    reasoningEffort,
    temperature,
  }: {
    model?: string;
    reasoningEffort?: ModelSettingsReasoningEffort | 'default';
    temperature?: number;
  } = {}): Agent {
    const resolvedModel = model?.trim() || this.#settings.get<string>('agent.model');
    this.#model = resolvedModel;
    const resolvedTemperature = temperature ?? this.#settings.get<number | undefined>('agent.temperature');
    const {
      name,
      instructions,
      tools: toolDefinitions,
    } = getAgentDefinition(
      {
        settingsService: this.#settings,
        loggingService: this.#logger,
        executionContext: this.#executionContext,
        askMentor: this.#createMentor,
        runSubagent: this.#runSubagent,
        getAskUserAnswer: (callId?: string) => this.getAskUserAnswer(callId),
      },
      resolvedModel,
    );

    const providerCapabilities = this.#getProviderCapabilities(this.#provider);
    const shouldUseNativePatchToolForModel = shouldUseNativePatchTool({
      providerId: this.#provider,
      model: resolvedModel,
      capabilities: providerCapabilities,
    });
    const tools = this.#buildAgentTools({
      toolDefinitions,
      resolvedModel,
      shouldUseNativePatchTool: shouldUseNativePatchToolForModel,
    });

    let effectiveReasoningEffort = reasoningEffort;
    const isDefaultSetting = this.#settings.get<string>('agent.reasoningEffort') === 'default';
    if (
      this.#provider === 'codex' &&
      isDefaultSetting &&
      (!effectiveReasoningEffort || effectiveReasoningEffort === 'default')
    ) {
      const defaultReasoningLevel = getModelDefaultReasoningLevel('codex', resolvedModel);
      if (defaultReasoningLevel) {
        effectiveReasoningEffort = defaultReasoningLevel as ModelSettingsReasoningEffort;
      }
    }

    const modelSettings = this.#buildModelSettings({
      reasoningEffort: effectiveReasoningEffort,
      resolvedTemperature,
    });

    const agent = new Agent({
      name,
      model: resolvedModel,
      ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
      instructions,
      tools,
    });

    // Only add defaultRunOptions if an explicit effort is set (not
    // 'default'). This ensures the API receives the param only when
    // intended.
    if (effectiveReasoningEffort && effectiveReasoningEffort !== 'default') {
      (agent as any).defaultRunOptions = {
        ...((agent as any).defaultRunOptions || {}),
        // Pass through to underlying client for models that support it
        reasoning: { effort: effectiveReasoningEffort },
      };
    }

    return agent;
  }

  #buildAgentTools({
    toolDefinitions,
    resolvedModel,
    shouldUseNativePatchTool,
  }: {
    toolDefinitions: any[];
    resolvedModel: string;
    reasoningEffort?: ModelSettingsReasoningEffort | 'default';
    shouldUseNativePatchTool: boolean;
  }): Tool[] {
    const providerCapabilities = this.#getProviderCapabilities(this.#provider);
    const useStrictToolSchema = shouldUseStrictToolSchema({
      providerId: this.#provider,
      capabilities: providerCapabilities,
    });
    const tools: Tool[] = toolDefinitions
      .filter((definition) => {
        // Exclude custom apply_patch if we're using native one
        if (shouldUseNativePatchTool && definition.name === 'apply_patch') {
          return false;
        }
        return true;
      })
      .map((definition) =>
        wrapToolInvoke(
          createTool({
            name: definition.name,
            description: definition.description,
            parameters: useStrictToolSchema ? toOpenAIStrictToolSchema(definition.parameters) : definition.parameters,
            // Let schema-validation errors propagate to wrapToolInvoke for Zod
            // diagnostics; keep other runtime errors as non-fatal strings.
            errorFunction: toolErrorFunction,
            needsApproval: wrapNeedsApproval(definition, {
              checkInterceptors: (params) => this.#checkToolInterceptors(definition.name, params),
            }),
            execute: async (params, _context, details) => {
              const maxOutputLengthValue = this.#settings.get<number | undefined>('shell.maxOutputChars');
              // Extract tool call ID from details if available
              const toolCallId = details?.toolCall?.callId;
              // Check if this execution should be intercepted
              const rejectionMessage = await this.#checkToolInterceptors(definition.name, params, toolCallId);
              if (rejectionMessage) {
                this.#logger.debug('Tool execution intercepted', {
                  tool: definition.name,
                  params: JSON.stringify(params).substring(0, 100),
                });
                // Return a failure response that all tools should understand
                const rejected = JSON.stringify({
                  output: [
                    {
                      success: false,
                      error: rejectionMessage,
                    },
                  ],
                });
                return trimToolOutput(rejected, undefined, maxOutputLengthValue ?? undefined);
              }

              const result = await definition.execute(params, _context, details);
              let trimmedResult = trimToolOutput(result, undefined, maxOutputLengthValue ?? undefined);

              // Inject warning when turns are approaching maxTurns
              const userContext: any = _context?.context;
              if (
                userContext &&
                typeof userContext.turnCount === 'number' &&
                typeof userContext.maxTurns === 'number'
              ) {
                const turnsLeft = userContext.maxTurns - userContext.turnCount;
                if (turnsLeft >= 0 && turnsLeft <= 5) {
                  const warning = `\n\n[Warning: You are approaching the maximum turn limit. You have ${turnsLeft} turns left. Please prepare to wrap up your work and provide a situation update message describing what has been completed and what remains to be done.]`;
                  trimmedResult = injectWarningIntoToolOutput(trimmedResult, warning);
                }
              }

              return trimmedResult;
            },
          }),
          definition.parameters,
        ),
      );

    // Add native applyPatchTool for gpt-5.1 on OpenAI provider
    if (shouldUseNativePatchTool) {
      const nativePatchTool = applyPatchTool({
        editor: this.#editor,
        needsApproval: false, // Default to auto-approve for now
      }) as any; // Type assertion needed as invoke is not in public API

      // Wrap the native tool's invoke function to apply interceptor check
      const originalInvoke = nativePatchTool.invoke;
      if (originalInvoke) {
        nativePatchTool.invoke = async (runContext: any, input: any, details: any) => {
          // Extract tool call ID from details if available
          const toolCallId = details?.toolCall?.callId;
          // Parse input to get params for logging
          const normalizedInput = normalizeToolInput(input);
          let params: any;
          try {
            params = typeof input === 'string' ? JSON.parse(input) : input;
          } catch {
            params = input;
          }
          const rejectionMessage = await this.#checkToolInterceptors('apply_patch', params, toolCallId);
          if (rejectionMessage) {
            this.#logger.debug('Native tool execution intercepted', {
              tool: 'apply_patch',
              toolCallId,
              params: JSON.stringify(params).substring(0, 100),
            });
            const rejected = JSON.stringify({
              output: [
                {
                  success: false,
                  error: rejectionMessage,
                },
              ],
            });
            const maxOutputLengthValue = this.#settings.get<number | undefined>('shell.maxOutputChars');
            return trimToolOutput(rejected, undefined, maxOutputLengthValue ?? undefined);
          }
          const maxOutputLengthValue = this.#settings.get<number | undefined>('shell.maxOutputChars');
          const result = await originalInvoke.call(nativePatchTool, runContext, normalizedInput, details);
          let trimmedResult = trimToolOutput(result, undefined, maxOutputLengthValue ?? undefined);

          // Inject warning when turns are approaching maxTurns
          const userContext: any = runContext?.context;
          if (userContext && typeof userContext.turnCount === 'number' && typeof userContext.maxTurns === 'number') {
            const turnsLeft = userContext.maxTurns - userContext.turnCount;
            if (turnsLeft >= 0 && turnsLeft <= 5) {
              const warning = `\n\n[Warning: You are approaching the maximum turn limit. You have ${turnsLeft} turns left. Please prepare to wrap up your work and provide a situation update message describing what has been completed and what remains to be done.]`;
              trimmedResult = injectWarningIntoToolOutput(trimmedResult, warning);
            }
          }

          return trimmedResult;
        };
      }

      tools.push(nativePatchTool);
      this.#logger.debug('Using native applyPatchTool from SDK', {
        model: resolvedModel,
        provider: this.#provider,
      });
    } else {
      this.#logger.debug('Using custom apply_patch implementation', {
        model: resolvedModel,
        provider: this.#provider,
      });
    }

    return tools;
  }

  #buildModelSettings({
    reasoningEffort,
    resolvedTemperature,
  }: {
    reasoningEffort?: ModelSettingsReasoningEffort | 'default';
    resolvedTemperature?: number;
  }): Record<string, any> {
    // Build modelSettings only if an explicit effort value (other than
    // 'default') was provided. 'default' means we should not pass the
    // effort param and allow the underlying API to choose the default.
    const modelSettings: Record<string, any> = {};
    if (reasoningEffort && reasoningEffort !== 'default') {
      modelSettings.reasoning = {
        effort: reasoningEffort,
        summary: 'auto',
      };
    }

    // Temperature: only pass when explicitly set (number). Undefined means
    // provider/model default.
    if (typeof resolvedTemperature === 'number' && Number.isFinite(resolvedTemperature)) {
      modelSettings.temperature = resolvedTemperature;
    }

    // OpenAI Flex Service Tier: only pass when enabled and using OpenAI provider
    // This reduces costs by using the flex service tier for lower priority requests
    // See: https://platform.openai.com/docs/guides/service-tier
    const useFlexServiceTier = this.#settings.get<boolean>('agent.useFlexServiceTier');
    if (
      useFlexServiceTier &&
      this.#serviceTierOverrideForNextRequest !== 'standard' &&
      (this.#provider === 'openai' || this.#provider === 'openrouter')
    ) {
      modelSettings.providerData = {
        ...(modelSettings.providerData || {}),
        service_tier: 'flex',
      };
    }

    if (this.#provider === 'codex') {
      modelSettings.store = false;
      modelSettings.include = ['reasoning.encrypted_content'];
    }

    return modelSettings;
  }

  getSettings(): ISettingsService {
    return this.#settings;
  }
}
