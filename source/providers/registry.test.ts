import test from 'ava';
import { getProvider, getAllProviders, getProviderIds, sortProvidersByOrder } from './index.js';

test('openai provider is registered', (t) => {
  const provider = getProvider('openai');
  t.truthy(provider, 'openai provider should be registered');
  t.is(provider?.id, 'openai');
  t.is(provider?.label, 'OpenAI');
  t.is(typeof provider?.fetchModels, 'function', 'fetchModels should be a function');
});

test('openrouter provider is registered', (t) => {
  const provider = getProvider('openrouter');
  t.truthy(provider, 'openrouter provider should be registered');
  t.is(provider?.id, 'openrouter');
  t.is(provider?.label, 'OpenRouter');
  t.is(typeof provider?.fetchModels, 'function', 'fetchModels should be a function');
});

test('getProvider returns undefined for unknown provider', (t) => {
  const provider = getProvider('nonexistent');
  t.is(provider, undefined);
});

test('getAllProviders returns array of provider definitions', (t) => {
  const providers = getAllProviders();
  t.true(Array.isArray(providers));
  t.true(providers.length >= 2, 'should have at least openai and openrouter');

  const ids = providers.map((p) => p.id);
  t.true(ids.includes('openai'));
  t.true(ids.includes('openrouter'));
});

test('getProviderIds returns array of provider IDs', (t) => {
  const ids = getProviderIds();
  t.true(Array.isArray(ids));
  t.true(ids.length >= 2, 'should have at least openai and openrouter');
  t.true(ids.includes('openai'));
  t.true(ids.includes('openrouter'));
});

test('provider definitions have required properties', (t) => {
  const providers = getAllProviders();

  for (const provider of providers) {
    t.is(typeof provider.id, 'string', `${provider.id}: id should be string`);
    t.is(typeof provider.label, 'string', `${provider.id}: label should be string`);
    t.is(typeof provider.fetchModels, 'function', `${provider.id}: fetchModels should be function`);

    // Optional properties
    if (provider.createRunner !== undefined) {
      t.is(typeof provider.createRunner, 'function', `${provider.id}: createRunner should be function if defined`);
    }

    if (provider.clearConversations !== undefined) {
      t.is(
        typeof provider.clearConversations,
        'function',
        `${provider.id}: clearConversations should be function if defined`,
      );
    }

    if (provider.sensitiveSettingKeys !== undefined) {
      t.true(
        Array.isArray(provider.sensitiveSettingKeys),
        `${provider.id}: sensitiveSettingKeys should be array if defined`,
      );
    }
  }
});

test('openai provider has createRunner function', (t) => {
  const provider = getProvider('openai');
  t.is(typeof provider?.createRunner, 'function');
});

test('openai provider exposes capabilities without requiring credentials', (t) => {
  const provider = getProvider('openai');
  t.deepEqual(provider?.capabilities, {
    supportsConversationChaining: true,
    supportsTracingControl: true,
    usesStrictToolSchema: true,
    supportsPromptCacheKey: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
  });
});

test('openrouter provider has createRunner function', (t) => {
  const provider = getProvider('openrouter');
  t.is(typeof provider?.createRunner, 'function');
});

test('openai provider has sensitiveSettingKeys defined', (t) => {
  const provider = getProvider('openai');
  t.truthy(provider?.sensitiveSettingKeys);
  t.true(Array.isArray(provider?.sensitiveSettingKeys));
  // OpenAI provider currently has an empty array
  t.is(provider!.sensitiveSettingKeys!.length, 0);
});

test('openrouter provider has sensitive setting keys', (t) => {
  const provider = getProvider('openrouter');
  t.truthy(provider?.sensitiveSettingKeys);
  t.true(Array.isArray(provider?.sensitiveSettingKeys));
  t.true(provider!.sensitiveSettingKeys!.includes('agent.openrouter.apiKey'));
  t.true(provider!.sensitiveSettingKeys!.includes('agent.openrouter.baseUrl'));
});

test('sortProvidersByOrder returns original order when providerOrder is empty', (t) => {
  const ids = ['openai', 'openrouter', 'codex'];
  const result = sortProvidersByOrder(ids, []);
  t.deepEqual(result, ['openai', 'openrouter', 'codex']);
});

test('sortProvidersByOrder reorders according to providerOrder', (t) => {
  const ids = ['openai', 'openrouter', 'codex'];
  const result = sortProvidersByOrder(ids, ['codex', 'openai']);
  t.deepEqual(result, ['codex', 'openai', 'openrouter']);
});

test('sortProvidersByOrder appends unknown providers at the end', (t) => {
  const ids = ['openai', 'openrouter', 'codex'];
  const result = sortProvidersByOrder(ids, ['anthropic', 'codex']);
  t.deepEqual(result, ['codex', 'openai', 'openrouter']);
});

test('sortProvidersByOrder ignores providerOrder entries not in the list', (t) => {
  const ids = ['openai', 'openrouter'];
  const result = sortProvidersByOrder(ids, ['codex', 'openrouter', 'openai']);
  t.deepEqual(result, ['openrouter', 'openai']);
});

test('sortProvidersByOrder preserves relative order of unordered providers', (t) => {
  const ids = ['a', 'b', 'c', 'd'];
  const result = sortProvidersByOrder(ids, ['c', 'a']);
  t.deepEqual(result, ['c', 'a', 'b', 'd']);
});
