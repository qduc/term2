import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { firecrawlProvider, isFirecrawlConfigured } from './firecrawl.provider.js';

const settings = (values: Record<string, unknown> = {}): any => ({
  get: (key: string) => values[key],
  getDynamic: (key: string) => values[key],
});
const logging: any = { debug: vi.fn(), error: vi.fn() };

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

it('normalizes Firecrawl results and forwards options', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: [{ title: 'Title', url: 'https://example.test', description: 'desc', markdown: 'content' }],
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal('fetch', fetch);

  const result = await firecrawlProvider.search(
    'query',
    { settingsService: settings({ 'webSearch.firecrawl.apiKey': 'key' }), loggingService: logging },
    {
      site: 'example.test',
      maxResults: 3,
      signal: AbortSignal.timeout(1000),
    },
  );

  expect(fetch).toHaveBeenCalledWith(
    'https://api.firecrawl.dev/v1/search',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer key' }),
    }),
  );
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(
    expect.objectContaining({
      query: 'query site:example.test',
      limit: 3,
    }),
  );
  expect(result.results[0]).toEqual({
    title: 'Title',
    url: 'https://example.test',
    content: 'desc',
    publishedDate: undefined,
  });
});

it('normalizes the nested Firecrawl response shape', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: { web: [{ title: 'Nested', url: 'https://nested.test', markdown: 'body' }] } }),
        {
          status: 200,
        },
      ),
    ),
  );

  const result = await firecrawlProvider.search(
    'query',
    { settingsService: settings({ 'webSearch.firecrawl.apiKey': 'key' }), loggingService: logging },
    { excludeDomains: ['blocked.test'] },
  );

  expect(JSON.parse((fetch as any).mock.calls[0][1].body)).toEqual({
    query: 'query -site:blocked.test',
  });
  expect(result.results[0]).toMatchObject({ title: 'Nested', url: 'https://nested.test', content: 'body' });
});

it('supports a configured Firecrawl base URL and maps API errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 503 })));
  await expect(
    firecrawlProvider.search('q', {
      settingsService: settings({
        'webSearch.firecrawl.baseUrl': 'http://localhost:3002/',
        'webSearch.firecrawl.apiKey': 'k',
      }),
      loggingService: logging,
    }),
  ).rejects.toThrow('Firecrawl API error (503): bad');
  expect(fetch).toHaveBeenCalledWith('http://localhost:3002/v1/search', expect.anything());
});

it('reports missing credentials and propagates abort', async () => {
  expect(isFirecrawlConfigured({ settingsService: settings() })).toBe(false);
  expect(
    isFirecrawlConfigured({ settingsService: settings({ 'webSearch.firecrawl.baseUrl': 'http://localhost:3002' }) }),
  ).toBe(true);
  await expect(firecrawlProvider.search('q', { settingsService: settings(), loggingService: logging })).rejects.toThrow(
    /configured/,
  );
  const selfHostedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  vi.stubGlobal('fetch', selfHostedFetch);
  await firecrawlProvider.search('q', {
    settingsService: settings({ 'webSearch.firecrawl.baseUrl': 'http://localhost:3002' }),
    loggingService: logging,
  });
  expect(selfHostedFetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
  vi.stubGlobal('fetch', fetch);
  await expect(
    firecrawlProvider.search(
      'q',
      { settingsService: settings({ 'webSearch.firecrawl.apiKey': 'k' }), loggingService: logging },
      { signal: controller.signal },
    ),
  ).rejects.toThrow('aborted');
});
