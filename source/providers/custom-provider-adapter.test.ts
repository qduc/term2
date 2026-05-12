import test from 'ava';
import { OpenAIProvider, OpenAIChatCompletionsModel, OpenAIResponsesModel } from '@openai/agents-openai';

import { createCustomProviderModelProvider, type CustomProviderConfig } from './openai-compatible.provider.js';
import { AiSdkAnthropicProvider } from './ai-sdk-anthropic.provider.js';
import { AiSdkGoogleProvider } from './ai-sdk-google.provider.js';

const baseConfig = {
  name: 'custom-provider',
  baseUrl: 'https://example.test',
  apiKey: 'test-key',
} satisfies CustomProviderConfig;

test('createCustomProviderModelProvider uses native chat-completions OpenAIProvider by default', async (t) => {
  const provider = createCustomProviderModelProvider(baseConfig, {
    defaultModel: 'model-a',
    fetch: async () => new Response('{}'),
  });

  t.true(provider instanceof OpenAIProvider);
  const model = await (provider as OpenAIProvider).getModel('model-a');
  t.true(model instanceof OpenAIChatCompletionsModel, 'default branch must resolve to chat-completions, not responses');
});

test('createCustomProviderModelProvider uses native responses OpenAIProvider for openai type', async (t) => {
  const provider = createCustomProviderModelProvider(
    {
      ...baseConfig,
      type: 'openai',
    },
    {
      defaultModel: 'model-a',
      fetch: async () => new Response('{}'),
    },
  );

  t.true(provider instanceof OpenAIProvider);
  const model = await (provider as OpenAIProvider).getModel('model-a');
  t.true(model instanceof OpenAIResponsesModel, 'openai type must use the Responses API');
});

test('createCustomProviderModelProvider uses Anthropic adapter for anthropic type', (t) => {
  const provider = createCustomProviderModelProvider(
    {
      ...baseConfig,
      type: 'anthropic',
    },
    {
      defaultModel: 'claude-test',
      fetch: async () => new Response('{}'),
    },
  );

  t.true(provider instanceof AiSdkAnthropicProvider);
});

test('createCustomProviderModelProvider uses Google adapter for google type', (t) => {
  const provider = createCustomProviderModelProvider(
    {
      ...baseConfig,
      type: 'google',
    },
    {
      defaultModel: 'gemini-test',
      fetch: async () => new Response('{}'),
    },
  );

  t.true(provider instanceof AiSdkGoogleProvider);
});
