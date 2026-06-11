import { Agent, Runner, type JsonSchemaDefinition, run } from '@openai/agents';
import { getProvider } from '../providers/index.js';
import { type ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { AgentConfiguration } from './agent-configuration.js';
import { RunnerManager } from './runner-manager.js';
import { fetchModels, getModelDefaultReasoningLevel } from '../services/model-service.js';

export interface AgentChatServiceDeps {
  agentConfig: AgentConfiguration;
  runnerManager: RunnerManager;
  settings: ISettingsService;
  logger: ILoggingService;
}

/**
 * Owns the simple chat and structured chat (chatJson) methods extracted from
 * AgentClient. Uses the same `#runAgentWithProvider` and `#extractResponse`
 * helpers with identical logic — the only difference is that references to
 * `this.#agentConfig`, `this.#runnerManager`, `this.#settings`, and
 * `this.#logger` are routed through the injected deps object.
 */
export class AgentChatService {
  #deps: AgentChatServiceDeps;

  constructor(deps: AgentChatServiceDeps) {
    this.#deps = deps;
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

  async chat(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ModelSettingsReasoningEffort | 'default';
      instructions?: string;
    } = {},
  ): Promise<string> {
    const { agentConfig, runnerManager, settings, logger } = this.#deps;

    const tempProvider = options.provider || agentConfig.getProvider();
    logger.debug('Agent chat request', {
      messageLength: message.length,
      model: options.model || agentConfig.getModel(),
      provider: tempProvider,
    });

    const isDefaultSetting = settings.get<string>('agent.reasoningEffort') === 'default';
    if (tempProvider === 'codex' && isDefaultSetting) {
      try {
        await fetchModels({ settingsService: settings, loggingService: logger }, 'codex');
        agentConfig.refreshAgent();
      } catch (err) {
        // ignore
      }
    }

    try {
      // Create a temporary agent for this specific chat request if params differ
      let agentForChat = agentConfig.getAgent();
      const tempModel = options.model || agentConfig.getModel();
      const tempEffort = options.reasoningEffort || agentConfig.reasoningEffort;

      if (options.model || options.reasoningEffort || options.instructions || options.provider) {
        const modelSettings: any = {
          retry: { maxRetries: 0 },
        };

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
      const runnerForChat = runnerManager.getOrCreateRunner(tempProvider);

      // We use a simplified run flow for chat
      const result = await this.#runAgentWithProvider(tempProvider, runnerForChat, agentForChat, message, {
        stream: false,
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
      reasoningEffort?: ModelSettingsReasoningEffort | 'default';
      instructions?: string;
      outputType: JsonSchemaDefinition;
    },
  ): Promise<unknown> {
    const { agentConfig, runnerManager, settings, logger } = this.#deps;

    const tempProvider = options.provider || agentConfig.getProvider();
    logger.debug('Agent structured chat request', {
      messageLength: message.length,
      model: options.model || agentConfig.getModel(),
      provider: tempProvider,
    });

    const isDefaultSetting = settings.get<string>('agent.reasoningEffort') === 'default';
    if (tempProvider === 'codex' && isDefaultSetting) {
      try {
        await fetchModels({ settingsService: settings, loggingService: logger }, 'codex');
        agentConfig.refreshAgent();
      } catch (err) {
        // ignore
      }
    }

    try {
      const tempModel = options.model || agentConfig.getModel();
      const tempEffort = options.reasoningEffort || agentConfig.reasoningEffort;
      const modelSettings: any = {
        retry: { maxRetries: 0 },
      };

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

      const runnerForChat = runnerManager.getOrCreateRunner(tempProvider);

      const result = await this.#runAgentWithProvider(tempProvider, runnerForChat, agentForChat, message, {
        stream: false,
        maxTurns: 1,
      });

      return result.finalOutput ?? this.#extractResponse(result);
    } catch (error) {
      logger.error('Agent structured chat failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}
