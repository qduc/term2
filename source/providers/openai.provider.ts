import { Runner, Model, ModelProvider } from '@openai/agents';
import { OpenAIResponsesModel } from '@openai/agents-openai';
import OpenAI from 'openai';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { createProviderFetch } from './fetch/composer.js';
import { FallbackResponsesModel } from './fallback-responses-model.js';
import { TimedResponsesWSModel } from './timed-responses-ws-model.js';
import { DEFAULT_TIMED_WS_TIMEOUTS } from './timed-ws-timeouts.js';

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

async function fetchOpenAIModels(
  _deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch as any,
): Promise<Array<{ id: string; name?: string }>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = process.env.OPENAI_API_KEY;
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

class FallbackOpenAIProvider implements ModelProvider {
  private readonly fallbackState = { isDowngraded: false };
  private readonly models = new Map<string, FallbackResponsesModel>();

  constructor(private readonly openAIClient: OpenAI, private readonly loggingService: any) {}

  getModel(modelName?: string): Model {
    const model = modelName || 'gpt-4o';
    const cached = this.models.get(model);
    if (cached) {
      return cached;
    }

    const wsModel = new TimedResponsesWSModel(this.openAIClient as any, model, {
      ...DEFAULT_TIMED_WS_TIMEOUTS,
    });
    const httpModel = new OpenAIResponsesModel(this.openAIClient as any, model);

    const fallbackModel = new FallbackResponsesModel(
      wsModel,
      httpModel,
      this.fallbackState,
      (err) => {
        this.loggingService.warn(
          `OpenAI WebSocket connection failed for model ${model}, falling back to HTTP responses API`,
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
      },
      this.loggingService,
      'openai',
    );

    this.models.set(model, fallbackModel);
    return fallbackModel;
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
  createRunner: ({ settingsService, loggingService }) => {
    const defaultModel = settingsService.get('agent.model') || 'gpt-4o';
    const openAIClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      fetch: createProviderFetch({
        providerId: 'openai',
        defaultModel,
        deps: { loggingService },
      }) as any,
    });

    return new Runner({
      modelProvider: new FallbackOpenAIProvider(openAIClient, loggingService),
    });
  },
  fetchModels: fetchOpenAIModels,
  clearConversations: undefined, // No conversation state to clear
  sensitiveSettingKeys: [],
  capabilities: {
    supportsConversationChaining: true,
    supportsTracingControl: true,
    usesStrictToolSchema: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
  },
});
