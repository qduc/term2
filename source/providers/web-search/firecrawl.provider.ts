import { registerWebSearchProvider } from './registry.js';
import type { ISettingsService } from '../../services/service-interfaces.js';
import type { WebSearchOptions, WebSearchProvider, WebSearchResponse, WebSearchDeps } from './types.js';

const defaultBaseUrl = 'https://api.firecrawl.dev';
const get = (settings: ISettingsService, key: string) => settings.get(key as never) as string | undefined;

async function searchFirecrawl(
  query: string,
  deps: WebSearchDeps,
  options: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const apiKey = get(deps.settingsService, 'webSearch.firecrawl.apiKey');
  if (!apiKey) throw new Error('Firecrawl API key is not configured. Configure webSearch.firecrawl.apiKey.');
  const baseUrl = (get(deps.settingsService, 'webSearch.firecrawl.baseUrl') || defaultBaseUrl).replace(/\/$/, '');
  const searchOptions = {
    ...(options.maxResults && { limit: options.maxResults }),
    ...(options.includeDomains && { includeDomains: options.includeDomains }),
    ...(options.excludeDomains && { excludeDomains: options.excludeDomains }),
  };
  const response = await fetch(`${baseUrl}/v1/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, pageOptions: undefined, searchOptions }),
    signal: options.signal,
  });
  if (!response.ok) {
    const text = await response.text();
    deps.loggingService.error('Firecrawl API error', { status: response.status, error: text });
    throw new Error(`Firecrawl API error (${response.status}): ${text}`);
  }
  const data = (await response.json()) as {
    data?: Array<{ title?: string; url?: string; description?: string; markdown?: string }>;
  };
  return {
    query,
    results: (data.data || []).map((item) => ({
      title: item.title || item.url || 'Untitled',
      url: item.url || '',
      content: item.description || item.markdown?.slice(0, 500) || '',
      publishedDate: undefined,
    })),
  };
}

function isConfigured({ settingsService }: { settingsService: ISettingsService }): boolean {
  return Boolean(get(settingsService, 'webSearch.firecrawl.apiKey'));
}

export const firecrawlProvider: WebSearchProvider = {
  id: 'firecrawl',
  label: 'Firecrawl',
  search: searchFirecrawl,
  isConfigured,
  sensitiveSettingKeys: ['webSearch.firecrawl.apiKey'],
};
registerWebSearchProvider(firecrawlProvider);
export { isConfigured as isFirecrawlConfigured };
