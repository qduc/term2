import { getCatalogModel } from '../providers/model-catalog/catalog.js';
import { resolveOutputAllocation } from '../services/agent-runtime/model-context-policy.js';
import { ApplicationRunLoop, type ApplicationAgent } from '../services/agent-runtime/application-run-loop.js';
import { getProvider } from '../providers/index.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { JsonSchemaDefinition } from '../contracts/model-types.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { AgentConfiguration } from './agent-configuration.js';
import {
  fetchModels,
  getModelDefaultReasoningLevel,
  getProviderDefaultReasoningLevel,
} from '../services/model-service.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';
import type { ISessionContextService } from '../services/service-interfaces.js';
import { selectAgentStreamItems } from '../services/agent-stream.js';
import type { AgentClientChatOptions, AgentClientChatResult } from '../services/conversation-agent-client.js';
import type { ModelRequestCost } from '../services/cost/model-cost.js';
import { normalizeUsage } from '../utils/ai/token-usage.js';
import type { ProviderInputItem } from '../contracts/provider-input.js';
import type { NestedModelBinding } from '../contracts/nested-run-driver.js';
import { waitForAbortableRead } from '../contracts/abort-aware-wait.js';

/** A failed dispatched helper still owns its request accounting. */
export class AgentChatFailure extends Error {
  constructor(readonly costRecords: readonly ModelRequestCost[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'AgentChatFailure';
  }
}

export interface AgentChatServiceDeps {
  agentConfig: AgentConfiguration;
  settings: ISettingsService;
  logger: ILoggingService;
  sessionContextService?: ISessionContextService;
  modelBinding?: NestedModelBinding;
}

/**
 * Owns the simple chat and structured chat (chatJson) methods extracted from
 * AgentClient. Uses the same `#runAgentWithProvider` and `#extractResponse`
 * helpers with identical logic — the only difference is that references to
 * the client-owned configuration and services are routed through the injected
 * deps object.
 */
export class AgentChatService {
  #deps: AgentChatServiceDeps;
  #modelCache = new Map<string, Promise<StreamedModelTurn>>();
  #helperLeases = new Set<{ release(): Promise<void> }>();
  #activeRunLoops = new Set<ApplicationRunLoop>();
  #activePreparations = new Set<AbortController>();
  #disposePromise?: Promise<void>;

  constructor(deps: AgentChatServiceDeps) {
    this.#deps = deps;
  }

  /** Clear models created with settings that may no longer be current. */
  clearModelCache(): void {
    this.#modelCache.clear();
  }

  /** Close direct-chat transports when their owning client ends. */
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.abort();
    const models = [...this.#modelCache.values()];
    this.#modelCache.clear();
    const releases = this.#deps.modelBinding
      ? [...this.#helperLeases].map((lease) => lease.release())
      : models.map(async (cached) => {
          const model = await cached;
          await (model as StreamedModelTurn & { close?: () => unknown }).close?.();
        });
    this.#helperLeases.clear();
    this.#disposePromise = Promise.allSettled(releases).then(() => undefined);
    return this.#disposePromise;
  }

  /** Abort every active simple or structured chat operation. */
  abort(): void {
    for (const controller of this.#activePreparations) controller.abort();
    for (const loop of this.#activeRunLoops) loop.abort();
  }

  /** Release one helper's chain bookkeeping without closing the shared root transport. */
  async releaseSummaryHistory(provider: string, model: string, providerHistoryKey: string): Promise<void> {
    const cached = this.#modelCache.get(`${provider}\0${model}`);
    if (!cached) return;
    try {
      (await cached).resetConversationState?.({ providerHistoryKey });
    } catch {
      this.#deps.logger.warn('Could not release context-summary provider history.');
    }
  }

  async #getModel(providerId: string, modelId: string): Promise<StreamedModelTurn> {
    const key = `${providerId}\0${modelId}`;
    const cached = this.#modelCache.get(key);
    if (cached) return cached;

    const providerDef = this.#deps.modelBinding
      ? this.#deps.modelBinding.providerDefinition(providerId)
      : getProvider(providerId);
    if (!providerDef?.createStreamedModel) {
      const providerLabel = providerDef?.label || providerId;
      throw new Error(
        `${providerLabel} is configured but could not be initialized. ` +
          `Please check that all required credentials and provider settings are set.`,
      );
    }
    const { settings, logger, sessionContextService } = this.#deps;
    const modelDeps = {
      settingsService: settings,
      loggingService: logger,
      sessionContextService,
    };
    const lease = this.#deps.modelBinding?.acquireHelper({ provider: providerId, model: modelId }, modelDeps);
    if (lease) this.#helperLeases.add(lease);
    const created = Promise.resolve(lease ? lease.original : providerDef.createStreamedModel(modelId, modelDeps));
    this.#modelCache.set(key, created);
    created.catch(() => {
      if (this.#modelCache.get(key) === created) this.#modelCache.delete(key);
    });
    return created;
  }

  async #runAgentWithProvider(
    providerId: string,
    agent: ApplicationAgent,
    input: any,
    options: { signal?: AbortSignal; maxTurns?: number },
  ): Promise<any> {
    // Resolve the model from inside the loop so cancellation also reaches a
    // provider factory that performs asynchronous initialization.
    const binding = this.#deps.modelBinding;
    if (binding?.hasUnsettledReads()) throw new Error('A prior adopted model read has not settled');
    const loop = new ApplicationRunLoop({
      resolveModel: () => this.#getModel(providerId, agent.model),
      ...(binding
        ? {
            abortPendingModelReads: true as const,
            recordBudgetStopCause: true as const,
            onDetachedModelRead: (operation: Promise<unknown>) => binding.trackDetachedRead(operation),
          }
        : {}),
    });
    this.#activeRunLoops.add(loop);
    try {
      const stream = loop.startStream(agent, input, { ...options, providerId });
      try {
        await stream.completed;
      } catch (error) {
        if (stream.runCostRecords?.length)
          throw new AgentChatFailure(stream.runCostRecords as ModelRequestCost[], error);
        throw error;
      }
      return stream;
    } finally {
      this.#activeRunLoops.delete(loop);
    }
  }

  #extractResponse(result: any): string {
    if (result.finalOutput) {
      return result.finalOutput;
    }

    // Fallback: extract from messages if finalOutput is missing
    const messages = Array.isArray(result.messages)
      ? result.messages
      : selectAgentStreamItems(result).filter((item: any) => item?.role === 'assistant' || item?.type === 'message');
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      const content = lastMessage?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((part: any) => part?.text || part?.value || '').join('');
      }
    }

    return '';
  }

  async chat(message: string, options: AgentClientChatOptions = {}): Promise<string> {
    return (await this.chatDetailed(message, options)).text;
  }

  /**
   * Summarize through the live agent's envelope without granting tool execution.
   * Keep schemas and model options intact for caching; an unexpected tool call
   * fails the helper run, never the real tool body.
   */
  async summarizeHistory(
    history: readonly ProviderInputItem[],
    request: string,
    agent: ApplicationAgent,
    provider: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<AgentClientChatResult> {
    const summaryAgent: ApplicationAgent = {
      ...agent,
      resolveInstructionsForRequest: undefined,
      resolveRequestSnapshot: undefined,
      defaultRunOptions: undefined,
      modelSettings: { ...agent.modelSettings, maxTokens },
      tools: agent.tools.map((tool) => ({
        ...tool,
        needsApproval: () => false,
        execute: async () => {
          throw new Error('Tools cannot execute during context summarization.');
        },
      })),
    };
    const result = await this.#runAgentWithProvider(
      provider,
      summaryAgent,
      [...history, { type: 'message', role: 'user', content: request }],
      { signal, maxTurns: 1 },
    );
    return {
      text: typeof result.finalOutput === 'string' ? result.finalOutput : '',
      usage: normalizeUsage(result.runUsage),
      ...(Array.isArray(result.runCostRecords) ? { costRecords: result.runCostRecords } : {}),
    };
  }

  chatDetailed(message: string, options: AgentClientChatOptions = {}): Promise<AgentClientChatResult> {
    if (!this.#deps.modelBinding) return this.#chatDetailed(message, options);
    const controller = new AbortController();
    this.#activePreparations.add(controller);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    return this.#chatDetailed(message, { ...options, signal }).finally(() =>
      this.#activePreparations.delete(controller),
    );
  }

  async #chatDetailed(message: string, options: AgentClientChatOptions): Promise<AgentClientChatResult> {
    const { agentConfig, settings, logger } = this.#deps;

    const tempProvider = options.provider || agentConfig.getProvider();
    logger.debug('Agent chat request', {
      messageLength: message.length,
      model: options.model || agentConfig.getModel(),
      provider: tempProvider,
    });

    const isDefaultSetting = settings.get('agent.reasoningEffort') === 'default';
    if (tempProvider === 'codex' && isDefaultSetting) {
      try {
        if (this.#deps.modelBinding) {
          const operation = this.#deps.modelBinding.fetchModels('codex', {
            settingsService: settings,
            loggingService: logger,
            signal: options.signal,
          });
          if (options.signal)
            await waitForAbortableRead(operation, options.signal, this.#deps.modelBinding.trackDetachedRead);
          else await operation;
          options.signal?.throwIfAborted();
        } else await fetchModels({ settingsService: settings, loggingService: logger }, 'codex');
        agentConfig.refreshAgent({ configurationChanged: false });
      } catch (_err) {
        if (this.#deps.modelBinding) options.signal?.throwIfAborted();
        // ignore
      }
    }

    try {
      // Create a temporary agent for this specific chat request if params differ
      const tempModel = options.model || agentConfig.getModel();
      let agentForChat = agentConfig.getAgent() ?? {
        name: 'Chat',
        model: tempModel,
        instructions: options.instructions || 'You are a helpful assistant.',
        tools: [],
      };
      const tempEffort = options.reasoningEffort || agentConfig.reasoningEffort;

      if (options.model || options.reasoningEffort || options.instructions || options.provider) {
        const modelSettings: any = {
          retry: { maxRetries: settings.get('agent.retryAttempts') ?? 2 },
          maxRequestInputTokens: settings.get('agent.maxRequestInputTokens'),
          maxStreamOutputChars: settings.get('agent.maxStreamOutputChars'),
          maxModelRequestDurationMs: settings.get('agent.maxModelRequestDurationMs'),
          maxModelStreamIdleMs: settings.get('agent.maxModelStreamIdleMs'),
          maxTokens:
            options.maxTokens ??
            resolveOutputAllocation(
              getCatalogModel(tempProvider, tempModel),
              settings.get('agent.maxOutputTokens'),
              settings.getSource?.('agent.maxOutputTokens') === 'default',
            ),
        };

        let effectiveEffort = tempEffort;
        if (isDefaultSetting && (!effectiveEffort || effectiveEffort === 'default')) {
          const defaultReasoningLevel =
            (this.#deps.modelBinding
              ? this.#deps.modelBinding.modelDefaultReasoningLevel(tempProvider, tempModel, settings)
              : getModelDefaultReasoningLevel(tempProvider, tempModel)) ??
            (this.#deps.modelBinding
              ? this.#deps.modelBinding.providerDefaultReasoningLevel(tempProvider)
              : getProviderDefaultReasoningLevel(tempProvider));
          if (defaultReasoningLevel) {
            effectiveEffort = defaultReasoningLevel as ReasoningEffortSetting;
          }
        }

        if (effectiveEffort && effectiveEffort !== 'default') {
          modelSettings.reasoning = {
            effort: effectiveEffort,
            summary: 'auto',
          };
        }

        // For simple chat, we generally don't need tools, but we keep the system instructions
        agentForChat = {
          name: 'Chat',
          model: tempModel,
          ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
          instructions: options.instructions || 'You are a helpful assistant.',
          tools: [],
        };
      }

      const result = await this.#runAgentWithProvider(tempProvider, agentForChat, message, {
        maxTurns: 1, // Chat is usually single turn
        signal: options.signal,
      });

      const usage = normalizeUsage(result.runUsage);
      return {
        text: this.#extractResponse(result),
        ...(usage ? { usage } : {}),
        ...(Array.isArray(result.runCostRecords) ? { costRecords: result.runCostRecords as ModelRequestCost[] } : {}),
      };
    } catch (error) {
      logger.error('Agent chat failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error; // Propagate error
    }
  }

  chatJson(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ReasoningEffortSetting | null;
      instructions?: string;
      outputType: JsonSchemaDefinition;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    if (!this.#deps.modelBinding) return this.#chatJson(message, options);
    const controller = new AbortController();
    this.#activePreparations.add(controller);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    return this.#chatJson(message, { ...options, signal }).finally(() => this.#activePreparations.delete(controller));
  }

  async #chatJson(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ReasoningEffortSetting | null;
      instructions?: string;
      outputType: JsonSchemaDefinition;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const { agentConfig, settings, logger } = this.#deps;

    const tempProvider = options.provider || agentConfig.getProvider();
    logger.debug('Agent structured chat request', {
      messageLength: message.length,
      model: options.model || agentConfig.getModel(),
      provider: tempProvider,
    });

    const isDefaultSetting = settings.get('agent.reasoningEffort') === 'default';
    if (tempProvider === 'codex' && isDefaultSetting) {
      try {
        if (this.#deps.modelBinding) {
          const operation = this.#deps.modelBinding.fetchModels('codex', {
            settingsService: settings,
            loggingService: logger,
            signal: options.signal,
          });
          if (options.signal)
            await waitForAbortableRead(operation, options.signal, this.#deps.modelBinding.trackDetachedRead);
          else await operation;
          options.signal?.throwIfAborted();
        } else await fetchModels({ settingsService: settings, loggingService: logger }, 'codex');
        agentConfig.refreshAgent({ configurationChanged: false });
      } catch (_err) {
        if (this.#deps.modelBinding) options.signal?.throwIfAborted();
        // ignore
      }
    }

    try {
      const tempModel = options.model || agentConfig.getModel();
      const tempEffort = options.reasoningEffort || agentConfig.reasoningEffort;
      const modelSettings: any = {
        retry: { maxRetries: settings.get('agent.retryAttempts') ?? 2 },
      };

      let effectiveEffort = tempEffort;
      if (isDefaultSetting && (!effectiveEffort || effectiveEffort === 'default')) {
        const defaultReasoningLevel =
          (this.#deps.modelBinding
            ? this.#deps.modelBinding.modelDefaultReasoningLevel(tempProvider, tempModel, settings)
            : getModelDefaultReasoningLevel(tempProvider, tempModel)) ??
          (this.#deps.modelBinding
            ? this.#deps.modelBinding.providerDefaultReasoningLevel(tempProvider)
            : getProviderDefaultReasoningLevel(tempProvider));
        if (defaultReasoningLevel) {
          effectiveEffort = defaultReasoningLevel as ReasoningEffortSetting;
        }
      }

      if (effectiveEffort && effectiveEffort !== 'default') {
        modelSettings.reasoning = {
          effort: effectiveEffort,
          summary: 'auto',
        };
      }

      const agentForChat: ApplicationAgent = {
        name: 'Chat',
        model: tempModel,
        ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
        instructions: options.instructions || 'You are a helpful assistant.',
        tools: [],
        outputType: options.outputType,
      };

      const result = await this.#runAgentWithProvider(tempProvider, agentForChat, message, {
        maxTurns: 1,
        ...(this.#deps.modelBinding && options.signal ? { signal: options.signal } : {}),
      });

      // Some OpenAI-compatible providers (including OpenRouter) can complete a
      // structured response with an empty finalOutput while still placing the
      // JSON content in the final message. Treat an empty string like a missing
      // output so the evaluator does not mistake a valid response for an
      // invalid one and issue an unnecessary repair request.
      return result.finalOutput || this.#extractResponse(result);
    } catch (error) {
      logger.error('Agent structured chat failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}
