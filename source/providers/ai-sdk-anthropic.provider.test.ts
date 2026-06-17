import { it, expect } from 'vitest';
import {
  addAnthropicPromptCachingToMessages,
  AiSdkAnthropicProvider,
  getMaxOutputTokens,
} from './ai-sdk-anthropic.provider.js';

it('addAnthropicPromptCachingToMessages adds cacheControl to the last Anthropic message only', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'first' },
    { role: 'user', content: 'last' },
  ];

  const result = addAnthropicPromptCachingToMessages(messages, 'claude-sonnet-4-5');

  expect(result[0]).not.toBe(messages[0]);
  expect(result[1]).toEqual(messages[1]);
  expect(result[2]).not.toBe(messages[2]);
  expect(result[0].providerOptions).toEqual({
    anthropic: {
      cacheControl: { type: 'ephemeral' },
    },
  });
  expect(result[1].providerOptions).toBe(undefined);
  expect(result[2].providerOptions).toEqual({
    anthropic: {
      cacheControl: { type: 'ephemeral' },
    },
  });
});

it('addAnthropicPromptCachingToMessages adds cacheControl to last system user and tool messages', () => {
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

  expect(result[4].providerOptions).toEqual({
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  expect(result[5].providerOptions).toEqual({
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  expect(result[6].providerOptions).toEqual({
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  expect(result[0].providerOptions).toBe(undefined);
  expect(result[1].providerOptions).toBe(undefined);
  expect(result[2].providerOptions).toBe(undefined);
  expect(result[3].providerOptions).toBe(undefined);
});

it('addAnthropicPromptCachingToMessages preserves existing Anthropic providerOptions', () => {
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

  expect(result[1].providerOptions).toEqual({
    anthropic: {
      topK: 5,
      cacheControl: { type: 'ephemeral' },
    },
    other: { enabled: true },
  });
});

it('addAnthropicPromptCachingToMessages leaves non-Anthropic models unchanged', () => {
  const messages = [{ role: 'user', content: 'hello' }];

  const result = addAnthropicPromptCachingToMessages(messages, 'gpt-4.1');

  expect(result).toBe(messages);
});

it('addAnthropicPromptCachingToMessages leaves qwen models unchanged by default', () => {
  const messages = [{ role: 'user', content: 'hello' }];

  const result = addAnthropicPromptCachingToMessages(messages, 'qwen3-coder');

  expect(result).toBe(messages);
});

it('addAnthropicPromptCachingToMessages supports provider-specific caching predicates', () => {
  const messages = [{ role: 'user', content: 'hello' }];

  const result = addAnthropicPromptCachingToMessages(messages, 'qwen3-coder', (modelId) => modelId.includes('qwen'));

  expect(result[0].providerOptions).toEqual({
    anthropic: {
      cacheControl: { type: 'ephemeral' },
    },
  });
});

it('AiSdkAnthropicProvider can be instantiated for Anthropic models', () => {
  const provider = new AiSdkAnthropicProvider({
    defaultModel: 'claude-sonnet-4-5',
    resolveConfig: () => ({
      apiKey: 'test-key',
      fetch: async () => new Response('{}'),
    }),
    createProvider: () => ((modelId: string) => ({ modelId })) as any,
  });

  expect(provider).toBeTruthy();
});

it('getMaxOutputTokens maps models correctly and defaults to 65536', () => {
  expect(getMaxOutputTokens('minimax-m3')).toBe(131072);
  expect(getMaxOutputTokens('qwen3.5-plus')).toBe(65536);
  expect(getMaxOutputTokens('deepseek-v4-flash')).toBe(384000);
  expect(getMaxOutputTokens('glm-5.1')).toBe(32768);
  expect(getMaxOutputTokens('anthropic/mimo-v2-omni')).toBe(128000);
  expect(getMaxOutputTokens('unknown-model')).toBe(65536);
  expect(getMaxOutputTokens('')).toBe(65536);
});
