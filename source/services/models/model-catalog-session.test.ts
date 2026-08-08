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
