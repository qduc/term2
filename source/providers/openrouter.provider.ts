import { Runner } from '@openai/agents';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { AiSdkOpenRouterProvider } from './ai-sdk-openrouter.provider.js';
import { createAiSdkLoggingFetch } from './ai-sdk-logging-fetch.js';
import { addCacheControlToLastTwoMessages } from './common/openai-compatible-messages.js';

type FetchLike = typeof fetch;

function createOpenRouterCacheControlFetch(fetchImpl: FetchLike): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (Array.isArray(body?.messages)) {
          addCacheControlToLastTwoMessages(body.messages, body.model);
          return fetchImpl(input, { ...init, body: JSON.stringify(body) });
        }
      } catch {
        /* fall through */
      }
    }
    return fetchImpl(input, init);
  }) as FetchLike;
}

async function fetchOpenRouterModels(
  deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch as any,
): Promise<Array<{ id: string; name?: string }>> {
  const { settingsService } = deps;

  const baseUrl = settingsService.get('agent.openrouter.baseUrl') || 'https://openrouter.ai/api/v1';
  const apiKey = settingsService.get('agent.openrouter.apiKey');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(`${baseUrl}/models`, { headers });
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed (${response.status})`);
  }

  const body = await response.json();
  const filteredData = (body?.data || []).filter(
    (item: any) => Array.isArray(item?.supported_parameters) && item.supported_parameters.includes('tools'),
  );

  if (!Array.isArray(filteredData)) return [];

  return filteredData
    .map((item: any) => {
      const id = item?.id || item?.model || '';
      const name = item?.name || item?.display_name || item?.description;
      return id ? { id, name } : null;
    })
    .filter(Boolean) as Array<{ id: string; name?: string }>;
}

// Register OpenRouter provider
registerProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  createRunner: ({ settingsService, loggingService }) => {
    const apiKey = settingsService.get('agent.openrouter.apiKey');
    if (!apiKey) {
      return null;
    }

    const defaultModel = settingsService.get('agent.model') || 'openrouter/auto';

    return new Runner({
      tracingDisabled: true,
      modelProvider: new AiSdkOpenRouterProvider({
        defaultModel,
        resolveConfig: () => ({
          baseURL: settingsService.get('agent.openrouter.baseUrl') || 'https://openrouter.ai/api/v1',
          apiKey,
          headers: {
            'HTTP-Referer': settingsService.get('agent.openrouter.referrer') || 'http://localhost',
            'X-Title': settingsService.get('agent.openrouter.title') || 'term2',
          },
          appUrl: settingsService.get('agent.openrouter.referrer') || 'http://localhost',
          appName: settingsService.get('agent.openrouter.title') || 'term2',
          fetch: createOpenRouterCacheControlFetch(
            createAiSdkLoggingFetch({
              provider: 'openrouter',
              model: settingsService.get('agent.model') || defaultModel,
              loggingService,
            }),
          ),
        }),
      }),
    });
  },
  fetchModels: fetchOpenRouterModels,
  sensitiveSettingKeys: [
    'agent.openrouter.apiKey',
    'agent.openrouter.baseUrl',
    'agent.openrouter.referrer',
    'agent.openrouter.title',
  ],
  capabilities: {
    supportsConversationChaining: false,
    supportsTracingControl: false,
  },
});
