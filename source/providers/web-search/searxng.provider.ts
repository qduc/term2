import { registerWebSearchProvider } from './registry.js';
import type { ISettingsService } from '../../services/service-interfaces.js';
import type { WebSearchOptions, WebSearchProvider, WebSearchResponse, WebSearchDeps } from './types.js';

const get = (settings: ISettingsService, key: string) => settings.get(key as never) as string | undefined;

async function searchSearxng(
  query: string,
  deps: WebSearchDeps,
  options: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const rawBaseUrl = get(deps.settingsService, 'webSearch.searxng.baseUrl');
  if (!rawBaseUrl) throw new Error('SearXNG base URL is not configured. Configure webSearch.searxng.baseUrl.');
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
    if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('must use http:// or https://');
  } catch (error) {
    throw new Error(`Invalid SearXNG base URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  const url = new URL('search', baseUrl);
  url.searchParams.set('q', options.site ? `${query} site:${options.site}` : query);
  url.searchParams.set('format', 'json');
  if (options.engines) url.searchParams.set('engines', options.engines);
  if (options.language) url.searchParams.set('language', options.language);
  if (options.timeRange) url.searchParams.set('time_range', options.timeRange);
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: options.signal });
  if (!response.ok) {
    const text = await response.text();
    deps.loggingService.error('SearXNG API error', { status: response.status, error: text });
    throw new Error(`SearXNG API error (${response.status}): ${text}`);
  }
  const data = (await response.json()) as {
    query?: string;
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      publishedDate?: string;
      published?: string;
      date?: string;
    }>;
  };
  const results = (data.results || []).slice(0, options.maxResults || 10);
  return {
    query: data.query || query,
    results: results.map((item) => ({
      title: item.title || 'Untitled',
      url: item.url || '',
      content: item.content || '',
      publishedDate: item.publishedDate || item.published || item.date,
    })),
  };
}

function isConfigured({ settingsService }: { settingsService: ISettingsService }): boolean {
  return Boolean(get(settingsService, 'webSearch.searxng.baseUrl'));
}

export const searxngProvider: WebSearchProvider = {
  id: 'searxng',
  label: 'SearXNG',
  search: searchSearxng,
  isConfigured,
};
registerWebSearchProvider(searxngProvider);
export { isConfigured as isSearxngConfigured };
