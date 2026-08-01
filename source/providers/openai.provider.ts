import OpenAI from 'openai';
import type { LegacyModel, LegacyModelProvider } from '../contracts/model.js';
import {
  OpenAIResponsesModelWithPromptCacheKey,
  OpenAIResponsesWSModelWithPromptCacheKey,
} from './openai-responses-model.js';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { createProviderFetch } from './fetch/composer.js';
import { RetryingModel } from './retrying-model.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import type { ProviderRequestCapture } from './provider-request-capture.js';
import { bridgeBackToTurn } from './agents-model-bridge.js';

export {
  OpenAIResponsesModelWithPromptCacheKey,
  OpenAIResponsesWSModelWithPromptCacheKey,
} from './openai-responses-model.js';

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

async function fetchOpenAIModels(
  deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch as any,
): Promise<Array<{ id: string; name?: string }>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = deps.settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(OPENAI_MODELS_URL, { headers });
  if (!response.ok) {
    throw new Error(`OpenAI models request failed (${response.status})`);
  }

  const body = await response.json();
  const raw = body?.data || [];

  if (!Array.isArray(raw)) return [];

  return raw
    .map((item: any) => {
      const id = item?.id || item?.model || '';
      const name = item?.name || item?.display_name || item?.description;
      return id ? { id, name } : null;
    })
    .filter(Boolean)
    .reverse() as Array<{ id: string; name?: string }>;
}

class _OpenAIProvider implements LegacyModelProvider {
  private readonly models = new Map<string, RetryingModel>();

  constructor(
    private readonly openAIClient: OpenAI,
    private readonly loggingService: any,
    private readonly transport: 'websocket' | 'http',
    private readonly retryAttempts: number,
    private readonly onRetry?: () => void,
    private readonly requestCapture?: ProviderRequestCapture,
  ) {}

  getModel(modelName?: string): LegacyModel {
    const model = modelName || 'gpt-4o';
    const cached = this.models.get(model);
    if (cached) {
      return cached;
    }

    const selectedModel =
      this.transport === 'http'
        ? new OpenAIResponsesModelWithPromptCacheKey(this.openAIClient as any, model, this.requestCapture)
        : new OpenAIResponsesWSModelWithPromptCacheKey(this.openAIClient as any, model, this.requestCapture);
    const retryingModel = new RetryingModel(selectedModel, {
      retryAttempts: this.retryAttempts,
      loggingService: this.loggingService,
      onRetry: this.onRetry,
    });

    this.models.set(model, retryingModel);
    return retryingModel;
  }

  async close(): Promise<void> {
    for (const model of this.models.values()) {
      await model.close();
    }
    this.models.clear();
  }
}

// Register OpenAI provider
registerProvider({
  id: 'openai',
  label: 'OpenAI',
  createStreamedModel: (model, { settingsService, loggingService, sessionContextService }) => {
    const defaultModel = settingsService.get('agent.model') || 'gpt-4o';
    const apiKey = settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
    const openAIClient = new OpenAI({
      apiKey: apiKey || 'placeholder',
      maxRetries: settingsService.get('agent.retryAttempts') ?? 2,
      fetch: createProviderFetch({
        providerId: 'openai',
        defaultModel,
        deps: { loggingService, sessionContextService: sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE },
      }) as any,
    });

    const selectedModel =
      settingsService.get('agent.transport') === 'http'
        ? new OpenAIResponsesModelWithPromptCacheKey(openAIClient, model || defaultModel)
        : new OpenAIResponsesWSModelWithPromptCacheKey(openAIClient, model || defaultModel);
    return bridgeBackToTurn(selectedModel);
  },
  fetchModels: fetchOpenAIModels,
  clearConversations: undefined, // No conversation state to clear
  sensitiveSettingKeys: [],
  capabilities: {
    supportsConversationChaining: true,
    supportsTracingControl: true,
    supportsPromptCacheKey: true,
    usesStrictToolSchema: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
  },
});
