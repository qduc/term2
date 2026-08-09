import { expect, it, vi } from 'vitest';
import { ModelCatalogSession } from './model-catalog-session.js';

const deps = (fetcher: (provider: string) => Promise<any[]>) => ({
  settingsService: { getDynamic: vi.fn(() => []) } as any,
  loggingService: { warn: vi.fn() } as any,
  fetcher,
});

it('caches successful loads and suppresses failed providers until refresh', async () => {
  const fetcher = vi.fn(async () => [{ id: 'model-a', provider: 'openai' }]);
  const session = new ModelCatalogSession(deps(fetcher));

  await session.load('openai');
  await session.load('openai');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(session.getCached('openai')).toHaveLength(1);

  session.refresh('openai');
  await session.load('openai');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('marks an older in-flight result stale when a newer provider load starts', async () => {
  let resolveFirst!: (models: any[]) => void;
  const first = new Promise<any[]>((resolve) => {
    resolveFirst = resolve;
  });
  const fetcher = vi.fn((provider: string) => (provider === 'openai' ? first : Promise.resolve([{ id: 'b' }])));
  const session = new ModelCatalogSession(deps(fetcher));

  const firstLoad = session.load('openai');
  const secondLoad = session.load('openrouter');
  resolveFirst([{ id: 'a' }]);

  expect((await secondLoad).kind).toBe('loaded');
  expect((await firstLoad).kind).toBe('stale');
});

it('does not surface an older rejected load after a newer provider load starts', async () => {
  let rejectFirst!: (error: Error) => void;
  const first = new Promise<any[]>((_, reject) => {
    rejectFirst = reject;
  });
  const fetcher = vi.fn((provider: string) => (provider === 'openai' ? first : Promise.resolve([{ id: 'b' }])));
  const session = new ModelCatalogSession(deps(fetcher));

  const firstLoad = session.load('openai');
  const secondLoad = session.load('openrouter');
  rejectFirst(new Error('old provider failed'));

  expect((await secondLoad).kind).toBe('loaded');
  expect((await firstLoad).kind).toBe('stale');
});

it('moves through providers that have credentials, with no-key providers excluded', () => {
  const settings = {
    get: (key: string) => (key === 'providerOrder' ? [] : undefined),
    getDynamic: (key: string) => (key === 'agent.openrouter.apiKey' ? 'configured' : undefined),
  } as any;
  const session = new ModelCatalogSession({
    settingsService: settings,
    loggingService: { warn: vi.fn() } as any,
    fetcher: async () => [],
  });

  expect(session.nextProvider('openai', 'next')).toBe('openrouter');
});

it('invalidates an in-flight load and clears failed state at a credential boundary', async () => {
  let resolveFetch!: (models: any[]) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<any[]>((resolve) => {
        resolveFetch = resolve;
      }),
  );
  const session = new ModelCatalogSession(deps(fetcher));

  const inFlight = session.load('remote-provider');
  session.invalidate('remote-provider');
  resolveFetch([{ id: 'stale-model' }]);

  expect((await inFlight).kind).toBe('stale');
  expect(session.getCached('remote-provider')).toBeUndefined();
  expect(session.shouldRetry('remote-provider', false)).toBe(true);
});

it('allows a failed provider to load again after credential invalidation', async () => {
  const fetcher = vi
    .fn<(_: string) => Promise<any[]>>()
    .mockRejectedValueOnce(new Error('missing credential'))
    .mockResolvedValueOnce([{ id: 'recovered-model' }]);
  const session = new ModelCatalogSession(deps(fetcher));

  await expect(session.load('remote-provider')).rejects.toThrow('missing credential');
  expect(session.shouldRetry('remote-provider', false)).toBe(false);

  session.invalidate('remote-provider');

  expect(session.shouldRetry('remote-provider', false)).toBe(true);
  await expect(session.load('remote-provider')).resolves.toMatchObject({
    kind: 'loaded',
    models: [{ id: 'recovered-model' }],
  });
});
