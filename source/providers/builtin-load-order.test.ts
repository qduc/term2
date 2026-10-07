// The builtin providers load on demand (model-service no longer imports them),
// so registration order is no longer "builtins first". These pin the two
// behaviours that order used to guarantee.
import { it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

it('lets a runtime provider registered before the builtins keep its id', async () => {
  const registry = await import('./registry.js');
  const runtime = { id: 'openai', label: 'Runtime', fetchModels: async () => [] };
  registry.upsertProvider(runtime);

  await import('./index.js');

  expect(registry.getProvider('openai')).toBe(runtime);
  expect(registry.getProvider('openrouter')).toBeTruthy();
});

it('does not load the builtin providers just by importing model-service', async () => {
  const registry = await import('./registry.js');
  await import('../services/model-service.js');

  expect(registry.getProviderIds()).toEqual([]);
});

it('loads the builtin providers when fetchModels misses the registry', async () => {
  const registry = await import('./registry.js');
  const { fetchModels } = await import('../services/model-service.js');
  const { createMockSettingsService } = await import('../services/settings/settings-service.mock.js');

  await expect(
    fetchModels(
      { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
      'no-such-provider',
    ),
  ).rejects.toThrow(/not registered/);

  expect(registry.getProvider('openai')).toBeTruthy();
});
