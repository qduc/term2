import { it, expect } from 'vitest';
import { getProvider, getAllProviders, getProviderIds, sortProvidersByOrder } from './index.js';

it('openai provider is registered', () => {
  const provider = getProvider('openai');
  expect(provider).toBeTruthy();
  expect(provider?.id).toBe('openai');
  expect(provider?.label).toBe('OpenAI');
  expect(typeof provider?.fetchModels, 'fetchModels should be a function').toBe('function');
});

it('openrouter provider is registered', () => {
  const provider = getProvider('openrouter');
  expect(provider).toBeTruthy();
  expect(provider?.id).toBe('openrouter');
  expect(provider?.label).toBe('OpenRouter');
  expect(typeof provider?.fetchModels, 'fetchModels should be a function').toBe('function');
});

it('getProvider returns undefined for unknown provider', () => {
  const provider = getProvider('nonexistent');
  expect(provider).toBe(undefined);
});

it('getAllProviders returns array of provider definitions', () => {
  const providers = getAllProviders();
  expect(Array.isArray(providers)).toBe(true);
  expect(providers.length >= 2).toBe(true);

  const ids = providers.map((p) => p.id);
  expect(ids.includes('openai')).toBe(true);
  expect(ids.includes('openrouter')).toBe(true);
});

it('getProviderIds returns array of provider IDs', () => {
  const ids = getProviderIds();
  expect(Array.isArray(ids)).toBe(true);
  expect(ids.length >= 2).toBe(true);
  expect(ids.includes('openai')).toBe(true);
  expect(ids.includes('openrouter')).toBe(true);
});

it('provider definitions have required properties', () => {
  const providers = getAllProviders();

  for (const provider of providers) {
    expect(typeof provider.id, `${provider.id}: id should be string`).toBe('string');
    expect(typeof provider.label, `${provider.id}: label should be string`).toBe('string');
    expect(typeof provider.fetchModels, `${provider.id}: fetchModels should be function`).toBe('function');

    // Optional properties
    if (provider.createRunner !== undefined) {
      expect(typeof provider.createRunner, `${provider.id}: createRunner should be function if defined`).toBe(
        'function',
      );
    }

    if (provider.clearConversations !== undefined) {
      expect(
        typeof provider.clearConversations,
        `${provider.id}: clearConversations should be function if defined`,
      ).toBe('function');
    }

    if (provider.sensitiveSettingKeys !== undefined) {
      expect(Array.isArray(provider.sensitiveSettingKeys)).toBe(true);
    }
  }
});

it('openai provider has createRunner function', () => {
  const provider = getProvider('openai');
  expect(typeof provider?.createRunner).toBe('function');
});

it('openai provider exposes capabilities without requiring credentials', () => {
  const provider = getProvider('openai');
  expect(provider?.capabilities).toEqual({
    supportsConversationChaining: true,
    supportsTracingControl: true,
    usesStrictToolSchema: true,
    supportsPromptCacheKey: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
  });
});

it('openrouter provider has createRunner function', () => {
  const provider = getProvider('openrouter');
  expect(typeof provider?.createRunner).toBe('function');
});

it('openai provider has sensitiveSettingKeys defined', () => {
  const provider = getProvider('openai');
  expect(provider?.sensitiveSettingKeys).toBeTruthy();
  expect(Array.isArray(provider?.sensitiveSettingKeys)).toBe(true);
  // OpenAI provider currently has an empty array
  expect(provider!.sensitiveSettingKeys!.length).toBe(0);
});

it('openrouter provider has sensitive setting keys', () => {
  const provider = getProvider('openrouter');
  expect(provider?.sensitiveSettingKeys).toBeTruthy();
  expect(Array.isArray(provider?.sensitiveSettingKeys)).toBe(true);
  expect(provider!.sensitiveSettingKeys!.includes('agent.openrouter.apiKey')).toBe(true);
  expect(provider!.sensitiveSettingKeys!.includes('agent.openrouter.baseUrl')).toBe(true);
});

it('sortProvidersByOrder returns original order when providerOrder is empty', () => {
  const ids = ['openai', 'openrouter', 'codex'];
  const result = sortProvidersByOrder(ids, []);
  expect(result).toEqual(['openai', 'openrouter', 'codex']);
});

it('sortProvidersByOrder reorders according to providerOrder', () => {
  const ids = ['openai', 'openrouter', 'codex'];
  const result = sortProvidersByOrder(ids, ['codex', 'openai']);
  expect(result).toEqual(['codex', 'openai', 'openrouter']);
});

it('sortProvidersByOrder appends unknown providers at the end', () => {
  const ids = ['openai', 'openrouter', 'codex'];
  const result = sortProvidersByOrder(ids, ['anthropic', 'codex']);
  expect(result).toEqual(['codex', 'openai', 'openrouter']);
});

it('sortProvidersByOrder ignores providerOrder entries not in the list', () => {
  const ids = ['openai', 'openrouter'];
  const result = sortProvidersByOrder(ids, ['codex', 'openrouter', 'openai']);
  expect(result).toEqual(['openrouter', 'openai']);
});

it('sortProvidersByOrder preserves relative order of unordered providers', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const result = sortProvidersByOrder(ids, ['c', 'a']);
  expect(result).toEqual(['c', 'a', 'b', 'd']);
});
