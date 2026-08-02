import { ApplicationRunLoop, type ApplicationAgent } from '../services/agent-runtime/application-run-loop.js';
import { getProvider } from '../providers/index.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { JsonSchemaDefinition } from '../contracts/model-types.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { AgentConfiguration } from './agent-configuration.js';
import { fetchModels, getModelDefaultReasoningLevel } from '../services/model-service.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';
import type { ISessionContextService } from '../services/service-interfaces.js';
import { selectAgentStreamItems } from '../services/agent-stream.js';

export interface AgentChatServiceDeps {
  agentConfig: AgentConfiguration;
  settings: ISettingsService;
  logger: ILoggingService;
  sessionContextService?: ISessionContextService;
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
  #activeRunLoops = new Set<ApplicationRunLoop>();

  constructor(deps: AgentChatServiceDeps) {
    this.#deps = deps;
  }

  /** Clear models created with settings that may no longer be current. */
  clearModelCache(): void {
    this.#modelCache.clear();
  }

  /** Abort every active simple or structured chat operation. */
  abort(): void {
    for (const loop of this.#activeRunLoops) loop.abort();
  }

  async #getModel(providerId: string, modelId: string): Promise<StreamedModelTurn> {
    const key = `${providerId}\0${modelId}`;
    const cached = this.#modelCache.get(key);
    if (cached) return cached;

    const providerDef = getProvider(providerId);
    if (!providerDef?.createStreamedModel) {
      const providerLabel = providerDef?.label || providerId;
      throw new Error(
        `${providerLabel} is configured but could not be initialized. ` +
          `Please check that all required credentials and provider settings are set.`,
      );
    }
    const { settings, logger, sessionContextService } = this.#deps;
    const created = Promise.resolve(
      providerDef.createStreamedModel(modelId, {
        settingsService: settings,
        loggingService: logger,
        sessionContextService,
      }),
    );
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
    const loop = new ApplicationRunLoop({ resolveModel: () => this.#getModel(providerId, agent.model) });
    this.#activeRunLoops.add(loop);
    try {
      const stream = loop.startStream(agent, input, options);
      await stream.completed;
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

  async chat(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ReasoningEffortSetting | null;
      instructions?: string;
    } = {},
  ): Promise<string> {
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
        await fetchModels({ settingsService: settings, loggingService: logger }, 'codex');
        agentConfig.refreshAgent();
      } catch (_err) {
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
        };

        let effectiveEffort = tempEffort;
        if (tempProvider === 'codex' && isDefaultSetting && (!effectiveEffort || effectiveEffort === 'default')) {
          const defaultReasoningLevel = getModelDefaultReasoningLevel('codex', tempModel);
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
      });

      return this.#extractResponse(result);
    } catch (error) {
      logger.error('Agent chat failed', {
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
      reasoningEffort?: ReasoningEffortSetting | null;
      instructions?: string;
      outputType: JsonSchemaDefinition;
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
        await fetchModels({ settingsService: settings, loggingService: logger }, 'codex');
        agentConfig.refreshAgent();
      } catch (_err) {
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
      if (tempProvider === 'codex' && isDefaultSetting && (!effectiveEffort || effectiveEffort === 'default')) {
        const defaultReasoningLevel = getModelDefaultReasoningLevel('codex', tempModel);
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
