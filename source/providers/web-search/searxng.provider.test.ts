import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isSearxngConfigured, searxngProvider } from './searxng.provider.js';

const settings = (values: Record<string, unknown> = {}): any => ({
  get: (key: string) => values[key],
  getDynamic: (key: string) => values[key],
});
const logging: any = { debug: vi.fn(), error: vi.fn() };
beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

it('builds a SearXNG request and normalizes results', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        query: 'q',
        results: [{ title: 'T', url: 'https://e.test', content: 'snippet', engine: 'google', publishedDate: 'today' }],
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const result = await searxngProvider.search(
    'q',
    { settingsService: settings({ 'webSearch.searxng.baseUrl': 'http://localhost:8080/' }), loggingService: logging },
    { engines: 'google', language: 'en', timeRange: 'day', maxResults: 5 },
  );
  const url = new URL(fetch.mock.calls[0][0]);
  expect(url.pathname).toBe('/search');
  expect(url.searchParams.get('format')).toBe('json');
  expect(url.searchParams.get('engines')).toBe('google');
  expect(result.results[0]).toMatchObject({
    title: 'T',
    url: 'https://e.test',
    content: 'snippet',
    publishedDate: 'today',
  });
});

it('rejects missing or unsafe base URLs and maps HTTP errors', async () => {
  expect(isSearxngConfigured({ settingsService: settings() })).toBe(false);
  await expect(searxngProvider.search('q', { settingsService: settings(), loggingService: logging })).rejects.toThrow(
    /base URL/,
  );
  await expect(
    searxngProvider.search('q', {
      settingsService: settings({ 'webSearch.searxng.baseUrl': 'file:///etc' }),
      loggingService: logging,
    }),
  ).rejects.toThrow(/http/);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 400 })));
  await expect(
    searxngProvider.search('q', {
      settingsService: settings({ 'webSearch.searxng.baseUrl': 'http://localhost:8080' }),
      loggingService: logging,
    }),
  ).rejects.toThrow('SearXNG API error (400): no');
});

it('passes abort signals to fetch', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 })));
  await searxngProvider.search(
    'q',
    { settingsService: settings({ 'webSearch.searxng.baseUrl': 'http://localhost:8080' }), loggingService: logging },
    { signal: controller.signal },
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((fetch as any).mock.calls[0][1].signal).toBe(controller.signal);
});
