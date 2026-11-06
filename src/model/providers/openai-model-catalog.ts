import type { ProviderDeps, ProviderFetch } from './registry.js';
import { buildOpenAICompatibleUrl } from './common/openai-compatible-utils.js';

/** Catalog I/O can be supplied independently of inference or global fetch. */
export function createOpenAIModelCatalog(options: { baseURL?: string; fetchImpl?: ProviderFetch } = {}) {
  return async function fetchOpenAIModels(
    deps: ProviderDeps,
    fetchImpl: ProviderFetch = options.fetchImpl ?? fetch,
  ): Promise<Array<{ id: string; name?: string }>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const apiKey = deps.settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const url = new URL(baseURL);
    url.pathname = buildOpenAICompatibleUrl(url.pathname, '/models');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('OpenAI model catalog requires an HTTP(S) base URL');
    }
    const response = await fetchImpl(url.toString(), { headers, ...(deps.signal ? { signal: deps.signal } : {}) });
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
  };
}
