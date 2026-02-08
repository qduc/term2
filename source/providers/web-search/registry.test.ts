import test from 'ava';
// Import directly from registry.js to avoid auto-registration of providers through index.js
import {
  registerWebSearchProvider,
  getWebSearchProvider,
  getDefaultWebSearchProvider,
  getAllWebSearchProviders,
  getConfiguredWebSearchProvider,
  clearWebSearchProviders,
} from './registry.js';
import type { WebSearchProvider } from './types.js';

// Helper to create a mock provider
const createMockProvider = (id: string, label: string): WebSearchProvider => ({
  id,
  label,
  search: async () => ({ query: 'test', results: [] }),
  isConfigured: () => true,
});

// Helper to create a mock settings service
const createMockSettingsService = (settings: Record<string, any> = {}) => ({
  get: <T>(key: string): T => settings[key] as T,
  set: () => {},
});

// Clear providers before each test to ensure isolation
test.beforeEach(() => {
  clearWebSearchProviders();
});

test.serial('registerWebSearchProvider registers a provider', (t) => {
  const provider = createMockProvider('test', 'Test');

  registerWebSearchProvider(provider);

  const registered = getWebSearchProvider('test');
  t.is(registered?.id, 'test');
  t.is(registered?.label, 'Test');
});

test.serial('registerWebSearchProvider throws on duplicate ID', (t) => {
  const provider1 = createMockProvider('dup-test', 'Test 1');
  const provider2 = createMockProvider('dup-test', 'Test 2');

  registerWebSearchProvider(provider1);

  const error = t.throws(() => registerWebSearchProvider(provider2));
  t.true(error?.message.includes("'dup-test' is already registered"));
});

test.serial('getWebSearchProvider returns registered provider', (t) => {
  const provider = createMockProvider('custom', 'Custom');
  registerWebSearchProvider(provider);

  const result = getWebSearchProvider('custom');

  t.is(result?.id, 'custom');
  t.is(result?.label, 'Custom');
});

test.serial('getWebSearchProvider returns undefined for unknown ID', (t) => {
  const result = getWebSearchProvider('nonexistent');
  t.is(result, undefined);
});

test.serial('getDefaultWebSearchProvider returns first registered provider', (t) => {
  const provider1 = createMockProvider('first', 'First');
  const provider2 = createMockProvider('second', 'Second');

  registerWebSearchProvider(provider1);
  registerWebSearchProvider(provider2);

  const result = getDefaultWebSearchProvider();
  t.is(result?.id, 'first');
});

test.serial('getDefaultWebSearchProvider respects isDefault option', (t) => {
  const provider1 = createMockProvider('first-def', 'First');
  const provider2 = createMockProvider('second-def', 'Second');

  registerWebSearchProvider(provider1);
  registerWebSearchProvider(provider2, { isDefault: true });

  const result = getDefaultWebSearchProvider();
  t.is(result?.id, 'second-def');
});

test.serial('getDefaultWebSearchProvider returns undefined when no providers registered', (t) => {
  const result = getDefaultWebSearchProvider();
  t.is(result, undefined);
});

test.serial('getAllWebSearchProviders returns all registered providers', (t) => {
  const provider1 = createMockProvider('one', 'One');
  const provider2 = createMockProvider('two', 'Two');

  registerWebSearchProvider(provider1);
  registerWebSearchProvider(provider2);

  const all = getAllWebSearchProviders();
  t.is(all.length, 2);
  t.truthy(all.find((p) => p.id === 'one'));
  t.truthy(all.find((p) => p.id === 'two'));
});

test.serial('getConfiguredWebSearchProvider uses settings preference', (t) => {
  const provider1 = createMockProvider('first-conf', 'First');
  const provider2 = createMockProvider('second-conf', 'Second');

  registerWebSearchProvider(provider1, { isDefault: true });
  registerWebSearchProvider(provider2);

  const settings = createMockSettingsService({ 'webSearch.provider': 'second-conf' });
  const result = getConfiguredWebSearchProvider({ settingsService: settings });

  t.is(result?.id, 'second-conf');
});

test.serial('getConfiguredWebSearchProvider falls back to default', (t) => {
  const provider = createMockProvider('default-fb', 'Default');
  registerWebSearchProvider(provider, { isDefault: true });

  const settings = createMockSettingsService({}); // No provider preference
  const result = getConfiguredWebSearchProvider({ settingsService: settings });

  t.is(result?.id, 'default-fb');
});

test.serial('getConfiguredWebSearchProvider falls back when configured provider not found', (t) => {
  const provider = createMockProvider('default-nf', 'Default');
  registerWebSearchProvider(provider, { isDefault: true });

  const settings = createMockSettingsService({ 'webSearch.provider': 'nonexistent' });
  const result = getConfiguredWebSearchProvider({ settingsService: settings });

  t.is(result?.id, 'default-nf');
});

test.serial('clearWebSearchProviders removes all providers', (t) => {
  registerWebSearchProvider(createMockProvider('test-clear', 'Test'));
  t.is(getAllWebSearchProviders().length, 1);

  clearWebSearchProviders();

  t.is(getAllWebSearchProviders().length, 0);
  t.is(getDefaultWebSearchProvider(), undefined);
});
