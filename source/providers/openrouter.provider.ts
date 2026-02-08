import { Runner } from '@openai/agents';
import { registerProvider } from './registry.js';
import { OpenRouterProvider } from './openrouter.js';

async function fetchOpenRouterModels(
  deps: { settingsService: any; loggingService: any },
  fetchImpl: (url: string, options?: any) => Promise<any> = fetch as any,
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

    return new Runner({
      modelProvider: new OpenRouterProvider({
        settingsService,
        loggingService,
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
});
