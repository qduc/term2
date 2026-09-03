import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerProvider, unregisterProvider } from '../../providers/registry.js';
import { orderedProviderIds } from './model-catalog-session.js';
import { filterModelGroups, formatModelGroups, runListModels, type ProviderModelGroup } from './model-listing.js';
import { clearModelCache, clearModelMemoryCacheForTest } from '../model-service.js';
import { SettingsService } from '../settings/settings-service.js';
import { LoggingService } from '../logging/logging-service.js';

const group = (provider: string, modelIds: string[]): ProviderModelGroup => ({
  provider,
  models: modelIds.map((id) => ({ id, provider })),
});

const listingDeps = (
  modelsByProvider: Record<string, Array<{ id: string; name?: string }>>,
  options?: { failProviders?: string[] },
) => ({
  settingsService: { get: vi.fn(), getDynamic: vi.fn(() => []) } as any,
  loggingService: { warn: vi.fn() } as any,
  fetcher: vi.fn(async (provider: string) => {
    if (options?.failProviders?.includes(provider)) throw new Error(`${provider} listing failed`);
    return (modelsByProvider[provider] ?? []).map((m) => ({ ...m, provider }));
  }),
  providerIds: [...Object.keys(modelsByProvider), ...(options?.failProviders ?? [])],
});

it('orders credentialed providers by providerOrder and drops credential-missing runtime providers', () => {
  const settings = {
    get: vi.fn(),
    getDynamic: vi.fn((key: string) => (key === 'providerOrder' ? ['fake-beta', 'fake-alpha'] : [])),
  } as any;
  registerProvider({ id: 'fake-alpha', label: 'Fake Alpha', fetchModels: async () => [] });
  registerProvider({ id: 'fake-beta', label: 'Fake Beta', fetchModels: async () => [] });
  registerProvider({ id: 'fake-gamma', label: 'Fake Gamma', fetchModels: async () => [], isRuntimeDefined: true });
  try {
    expect(orderedProviderIds(settings, ['fake-alpha', 'fake-gamma', 'fake-beta'])).toEqual([
      'fake-beta',
      'fake-alpha',
    ]);
  } finally {
    unregisterProvider('fake-alpha');
    unregisterProvider('fake-beta');
    unregisterProvider('fake-gamma');
  }
});

it('returns the groups unchanged when the search term is blank', () => {
  const groups = [group('alpha', ['m1']), group('beta', ['m2'])];
  expect(filterModelGroups(groups, '  ')).toBe(groups);
});

it('keeps every model of a provider whose id matches the search', () => {
  const groups = [group('alpha', ['delta-one', 'delta-two']), group('beta', ['beta-model'])];
  const filtered = filterModelGroups(groups, 'alp');
  expect(filtered).toHaveLength(1);
  expect(filtered[0].provider).toBe('alpha');
  expect(filtered[0].models.map((m) => m.id)).toEqual(['delta-one', 'delta-two']);
});

it('filters models by case-insensitive fuzzy subsequence over the model id when the provider id does not match', () => {
  const groups = [group('zeta', ['gpt-5.4', 'gpt-5.4-mini', 'claude-opus'])];
  expect(filterModelGroups(groups, 'GPT5')[0].models.map((m) => m.id)).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
});

it('drops providers without matching models', () => {
  const groups = [group('alpha', ['alpha-model']), group('beta', ['beta-model'])];
  expect(filterModelGroups(groups, 'alp').map((g) => g.provider)).toEqual(['alpha']);
});

it('renders a provider header with its label and indented model lines', () => {
  const out = formatModelGroups([
    { provider: 'openai', label: 'OpenAI', models: [{ id: 'gpt-5.4', name: 'GPT 5.4', provider: 'openai' }] },
  ]);
  expect(out).toBe('openai (OpenAI):\n  gpt-5.4  GPT 5.4');
});

it('omits the label and model name when they duplicate the ids', () => {
  const out = formatModelGroups([
    { provider: 'grok', label: 'grok', models: [{ id: 'grok-4', name: 'grok-4', provider: 'grok' }] },
  ]);
  expect(out).toBe('grok:\n  grok-4');
});

it('skips providers without models', () => {
  expect(formatModelGroups([group('alpha', []), group('beta', ['beta-model'])])).toBe('beta:\n  beta-model');
});

it('prints providers grouped with their models and exits 0', async () => {
  const outcome = await runListModels(
    listingDeps({
      'fake-alpha': [{ id: 'alpha-1' }, { id: 'alpha-2' }],
      'fake-beta': [{ id: 'beta-1', name: 'Beta One' }],
    }),
  );
  expect(outcome.exitCode).toBe(0);
  expect(outcome.output).toBe('fake-alpha:\n  alpha-1\n  alpha-2\nfake-beta:\n  beta-1  Beta One');
  expect(outcome.warnings).toEqual([]);
  expect(outcome.error).toBeNull();
});

it('warns about a failed provider listing and still prints the others', async () => {
  const outcome = await runListModels(
    listingDeps({ 'fake-alpha': [{ id: 'alpha-1' }] }, { failProviders: ['fake-beta'] }),
  );
  expect(outcome.exitCode).toBe(0);
  expect(outcome.warnings).toEqual(['warning: fake-beta: fake-beta listing failed']);
  expect(outcome.output).toBe('fake-alpha:\n  alpha-1');
});

it('applies the search term across provider and model ids', async () => {
  const byProvider = await runListModels({
    ...listingDeps({ 'fake-alpha': [{ id: 'alpha-1' }], 'fake-beta': [{ id: 'beta-1' }] }),
    search: 'fakealpha',
  });
  expect(byProvider.exitCode).toBe(0);
  expect(byProvider.output).toBe('fake-alpha:\n  alpha-1');

  const byModel = await runListModels({
    ...listingDeps({ 'fake-alpha': [{ id: 'alpha-1' }], 'fake-beta': [{ id: 'beta-9' }] }),
    search: 'beta-9',
  });
  expect(byModel.exitCode).toBe(0);
  expect(byModel.output).toBe('fake-beta:\n  beta-9');
});

it('exits 1 with an explanation when the search matches nothing', async () => {
  const outcome = await runListModels({ ...listingDeps({ 'fake-alpha': [{ id: 'alpha-1' }] }), search: 'zzz' });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.output).toBeNull();
  expect(outcome.error).toBe('No models match "zzz".');
});

it('exits 1 when no provider is available', async () => {
  const outcome = await runListModels({ ...listingDeps({}), providerIds: [] });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.output).toBeNull();
  expect(outcome.error).toBe('No models available.');
});

it('runListModels reuses disk cache across separate invocations without custom fetcher', async () => {
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-list-models-cache-'));
  const providerId = 'list-models-disk-test';
  let networkFetches = 0;
  registerProvider({
    id: providerId,
    label: 'List Models Disk Test',
    fetchModels: async () => {
      networkFetches++;
      return [{ id: 'cached-cli-model' }];
    },
  });

  try {
    const deps = {
      settingsService: { get: vi.fn(), getDynamic: vi.fn(() => []) } as any,
      loggingService: { warn: vi.fn() } as any,
      providerIds: [providerId],
      cacheDir: customDir,
    };

    // First CLI errand: cold in-memory and cold disk
    const first = await runListModels(deps);
    expect(first.exitCode).toBe(0);
    expect(first.output).toContain('cached-cli-model');
    expect(networkFetches).toBe(1);

    // Simulate process exit and new process startup: in-memory cache is wiped
    clearModelMemoryCacheForTest();

    // Second CLI errand within 1 hour: should read from disk cache, networkFetches stays 1
    const second = await runListModels(deps);
    expect(second.exitCode).toBe(0);
    expect(second.output).toContain('cached-cli-model');
    expect(networkFetches, 'Second CLI errand must hit disk cache without hitting provider API').toBe(1);
  } finally {
    unregisterProvider(providerId);
    clearModelCache(providerId, { cacheDir: customDir });
    try {
      fs.rmSync(customDir, { recursive: true, force: true });
    } catch {}
  }
});

it('runListModels with providerIds omitted selects and orders providers via the real credential/order path', async () => {
  // This exercises collectProviderModels' default branch —
  // orderedProviderIds(deps.settingsService, getProviderIds()) — through a
  // real SettingsService, not a stubbed one. Every other case in this file
  // injects providerIds explicitly and never touches that path.
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-list-models-settings-'));
  const loggingService = new LoggingService({ disableLogging: true });
  // 'providers' is not runtime-modifiable (requires restart), so seed it via
  // the on-disk settings file the constructor loads, the same way a real
  // user's stored custom-provider credentials would be present at startup.
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      providers: [
        {
          id: 'findings-cred-a',
          name: 'findings-cred-a',
          type: 'openai-compatible',
          baseUrl: 'https://findings-cred-a.example.test/v1',
          apiKey: 'secret-a',
        },
        {
          id: 'findings-cred-b',
          name: 'findings-cred-b',
          type: 'openai-compatible',
          baseUrl: 'https://findings-cred-b.example.test/v1',
          apiKey: 'secret-b',
        },
      ],
    }),
    'utf-8',
  );
  const settingsService = new SettingsService({ settingsDir, disableLogging: true, disableFilePersistence: true });

  // Defensive: a previous failed run in this suite may have left these
  // registered if it errored before reaching the try/finally below.
  unregisterProvider('findings-cred-a');
  unregisterProvider('findings-cred-b');
  unregisterProvider('findings-no-cred');

  try {
    registerProvider({
      id: 'findings-cred-a',
      label: 'Findings Cred A',
      isRuntimeDefined: true,
      fetchModels: async () => [],
    });
    registerProvider({
      id: 'findings-cred-b',
      label: 'Findings Cred B',
      isRuntimeDefined: true,
      fetchModels: async () => [],
    });
    registerProvider({
      id: 'findings-no-cred',
      label: 'Findings No Cred',
      isRuntimeDefined: true,
      fetchModels: async () => [],
    });

    // Credentials live in real settings state (seeded above on disk),
    // resolved through hasProviderCredentials -> resolveProviderCredentials
    // -> the stored custom-provider list. findings-no-cred has no matching
    // entry, so it stays credential-missing and must be dropped.
    //
    // providerOrder is the only thing that should determine ordering among
    // the credentialed providers; put b before a to prove it isn't
    // registration or alphabetical order leaking through.
    settingsService.setDynamic('providerOrder', ['findings-cred-b', 'findings-cred-a']);

    // The real registry also holds this host's other providers (codex,
    // grok, openai, ...), whose actual credential state is host-dependent
    // and would make this test flaky if it leaked into the output. Making
    // every non-"findings-*" provider fail its fetch keeps the assertion
    // hermetic: collectProviderModels demotes a failed fetch to an
    // {models: [], error} group, which filterModelGroups then drops, so
    // whether some other host provider happens to be credentialed cannot
    // affect what shows up below. The providerIds *selection* and *order*
    // are still driven entirely by the real orderedProviderIds/settings
    // path — only the model data itself is stubbed via the fetcher seam.
    const outcome = await runListModels({
      settingsService: settingsService as any,
      loggingService: loggingService as any,
      fetcher: async (provider: string) => {
        if (!provider.startsWith('findings-')) throw new Error(`unexpected provider ${provider}`);
        return [{ id: `${provider}-model`, provider }];
      },
      // providerIds intentionally omitted: exercises the default
      // orderedProviderIds(deps.settingsService, getProviderIds()) branch.
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).not.toBeNull();
    const providerOrderInOutput = (outcome.output ?? '')
      .split('\n')
      .filter((line) => line.endsWith(':'))
      .map((line) => line.replace(/:$/, '').split(' (')[0]);

    expect(providerOrderInOutput).toEqual(['findings-cred-b', 'findings-cred-a']);
    expect(outcome.output).not.toContain('findings-no-cred');
  } finally {
    unregisterProvider('findings-cred-a');
    unregisterProvider('findings-cred-b');
    unregisterProvider('findings-no-cred');
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
});
