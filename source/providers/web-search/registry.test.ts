import { it, expect, beforeEach } from 'vitest';
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
beforeEach(() => {
  clearWebSearchProviders();
});

it.sequential('registerWebSearchProvider registers a provider', () => {
  const provider = createMockProvider('test', 'Test');

  registerWebSearchProvider(provider);

  const registered = getWebSearchProvider('test');
  expect(registered?.id).toBe('test');
  expect(registered?.label).toBe('Test');
});

it.sequential('registerWebSearchProvider throws on duplicate ID', () => {
  const provider1 = createMockProvider('dup-test', 'Test 1');
  const provider2 = createMockProvider('dup-test', 'Test 2');

  registerWebSearchProvider(provider1);

  expect(() => registerWebSearchProvider(provider2)).toThrow(/'dup-test' is already registered/);
});

it.sequential('getWebSearchProvider returns registered provider', () => {
  const provider = createMockProvider('custom', 'Custom');
  registerWebSearchProvider(provider);

  const result = getWebSearchProvider('custom');

  expect(result?.id).toBe('custom');
  expect(result?.label).toBe('Custom');
});

it.sequential('getWebSearchProvider returns undefined for unknown ID', () => {
  const result = getWebSearchProvider('nonexistent');
  expect(result).toBe(undefined);
});

it.sequential('getDefaultWebSearchProvider returns first registered provider', () => {
  const provider1 = createMockProvider('first', 'First');
  const provider2 = createMockProvider('second', 'Second');

  registerWebSearchProvider(provider1);
  registerWebSearchProvider(provider2);

  const result = getDefaultWebSearchProvider();
  expect(result?.id).toBe('first');
});

it.sequential('getDefaultWebSearchProvider respects isDefault option', () => {
  const provider1 = createMockProvider('first-def', 'First');
  const provider2 = createMockProvider('second-def', 'Second');

  registerWebSearchProvider(provider1);
  registerWebSearchProvider(provider2, { isDefault: true });

  const result = getDefaultWebSearchProvider();
  expect(result?.id).toBe('second-def');
});

it.sequential('getDefaultWebSearchProvider returns undefined when no providers registered', () => {
  const result = getDefaultWebSearchProvider();
  expect(result).toBe(undefined);
});

it.sequential('getAllWebSearchProviders returns all registered providers', () => {
  const provider1 = createMockProvider('one', 'One');
  const provider2 = createMockProvider('two', 'Two');

  registerWebSearchProvider(provider1);
  registerWebSearchProvider(provider2);

  const all = getAllWebSearchProviders();
  expect(all.length).toBe(2);
  expect(all.find((p) => p.id === 'one')).toBeTruthy();
  expect(all.find((p) => p.id === 'two')).toBeTruthy();
});

it.sequential('getConfiguredWebSearchProvider uses settings preference', () => {
  const provider1 = createMockProvider('first-conf', 'First');
  const provider2 = createMockProvider('second-conf', 'Second');

  registerWebSearchProvider(provider1, { isDefault: true });
  registerWebSearchProvider(provider2);

  const settings = createMockSettingsService({ 'webSearch.provider': 'second-conf' });
  const result = getConfiguredWebSearchProvider({ settingsService: settings });

  expect(result?.id).toBe('second-conf');
});

it.sequential('getConfiguredWebSearchProvider falls back to default', () => {
  const provider = createMockProvider('default-fb', 'Default');
  registerWebSearchProvider(provider, { isDefault: true });

  const settings = createMockSettingsService({}); // No provider preference
  const result = getConfiguredWebSearchProvider({ settingsService: settings });

  expect(result?.id).toBe('default-fb');
});

it.sequential('getConfiguredWebSearchProvider falls back when configured provider not found', () => {
  const provider = createMockProvider('default-nf', 'Default');
  registerWebSearchProvider(provider, { isDefault: true });

  const settings = createMockSettingsService({ 'webSearch.provider': 'nonexistent' });
  const result = getConfiguredWebSearchProvider({ settingsService: settings });

  expect(result?.id).toBe('default-nf');
});

it.sequential('clearWebSearchProviders removes all providers', () => {
  registerWebSearchProvider(createMockProvider('test-clear', 'Test'));
  expect(getAllWebSearchProviders().length).toBe(1);

  clearWebSearchProviders();

  expect(getAllWebSearchProviders().length).toBe(0);
  expect(getDefaultWebSearchProvider()).toBe(undefined);
});
