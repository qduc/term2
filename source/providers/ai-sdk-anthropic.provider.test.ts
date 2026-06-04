import test from 'ava';
import {
  addAnthropicPromptCachingToMessages,
  AiSdkAnthropicProvider,
  getMaxOutputTokens,
} from './ai-sdk-anthropic.provider.js';

test('addAnthropicPromptCachingToMessages adds cacheControl to the last Anthropic message only', (t) => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'first' },
    { role: 'user', content: 'last' },
  ];

  const result = addAnthropicPromptCachingToMessages(messages, 'claude-sonnet-4-5');

  t.not(result[0], messages[0]);
  t.deepEqual(result[1], messages[1]);
  t.not(result[2], messages[2]);
  t.deepEqual(result[0].providerOptions, {
    anthropic: {
      cacheControl: { type: 'ephemeral' },
    },
  });
  t.is(result[1].providerOptions, undefined);
  t.deepEqual(result[2].providerOptions, {
    anthropic: {
      cacheControl: { type: 'ephemeral' },
    },
  });
});

test('addAnthropicPromptCachingToMessages adds cacheControl to last system user and tool messages', (t) => {
  const messages = [
    { role: 'system', content: 'system 1' },
    { role: 'user', content: 'user 1' },
    { role: 'tool', content: 'tool 1' },
    { role: 'assistant', content: 'assistant 1' },
    { role: 'system', content: 'system 2' },
    { role: 'user', content: 'user 2' },
    { role: 'tool', content: 'tool 2' },
  ];

  const result = addAnthropicPromptCachingToMessages(messages, 'claude-sonnet-4-5');

  t.deepEqual(result[4].providerOptions, {
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  t.deepEqual(result[5].providerOptions, {
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  t.deepEqual(result[6].providerOptions, {
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  t.is(result[0].providerOptions, undefined);
  t.is(result[1].providerOptions, undefined);
  t.is(result[2].providerOptions, undefined);
  t.is(result[3].providerOptions, undefined);
});

test('addAnthropicPromptCachingToMessages preserves existing Anthropic providerOptions', (t) => {
  const messages = [
    { role: 'user', content: 'hello' },
    {
      role: 'user',
      content: 'world',
      providerOptions: {
        anthropic: { topK: 5 },
        other: { enabled: true },
      },
    },
  ];

  const result = addAnthropicPromptCachingToMessages(messages, 'anthropic/claude-3-5-sonnet');

  t.deepEqual(result[1].providerOptions, {
    anthropic: {
      topK: 5,
      cacheControl: { type: 'ephemeral' },
    },
    other: { enabled: true },
  });
});

test('addAnthropicPromptCachingToMessages leaves non-Anthropic models unchanged', (t) => {
  const messages = [{ role: 'user', content: 'hello' }];

  const result = addAnthropicPromptCachingToMessages(messages, 'gpt-4.1');

  t.is(result, messages);
});

test('addAnthropicPromptCachingToMessages leaves qwen models unchanged by default', (t) => {
  const messages = [{ role: 'user', content: 'hello' }];

  const result = addAnthropicPromptCachingToMessages(messages, 'qwen3-coder');

  t.is(result, messages);
});

test('addAnthropicPromptCachingToMessages supports provider-specific caching predicates', (t) => {
  const messages = [{ role: 'user', content: 'hello' }];

  const result = addAnthropicPromptCachingToMessages(messages, 'qwen3-coder', (modelId) => modelId.includes('qwen'));

  t.deepEqual(result[0].providerOptions, {
    anthropic: {
      cacheControl: { type: 'ephemeral' },
    },
  });
});

test('AiSdkAnthropicProvider can be instantiated for Anthropic models', (t) => {
  const provider = new AiSdkAnthropicProvider({
    defaultModel: 'claude-sonnet-4-5',
    resolveConfig: () => ({
      apiKey: 'test-key',
      fetch: async () => new Response('{}'),
    }),
    createProvider: () => ((modelId: string) => ({ modelId })) as any,
  });

  t.truthy(provider);
});

test('getMaxOutputTokens maps models correctly and defaults to 128000', (t) => {
  t.is(getMaxOutputTokens('minimax-m3'), 131072);
  t.is(getMaxOutputTokens('qwen3.5-plus'), 65536);
  t.is(getMaxOutputTokens('deepseek-v4-flash'), 384000);
  t.is(getMaxOutputTokens('glm-5.1'), 32768);
  t.is(getMaxOutputTokens('anthropic/mimo-v2-omni'), 128000);
  t.is(getMaxOutputTokens('unknown-model'), 128000);
  t.is(getMaxOutputTokens(''), 128000);
});
