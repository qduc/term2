import test from 'ava';
import { OpenAIProvider, OpenAIChatCompletionsModel, OpenAIResponsesModel } from '@openai/agents-openai';

import {
  createCustomProviderModelProvider,
  sanitizeResponsesApiBody,
  type CustomProviderConfig,
  OpencodeMinimaxHybridProvider,
} from './openai-compatible.provider.js';
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

test('sanitizeResponsesApiBody removes empty replayed response messages', (t) => {
  const body = sanitizeResponsesApiBody({
    input: [
      { role: 'user', type: 'message', content: 'start' },
      {
        role: 'assistant',
        type: 'message',
        content: [],
        provider_data: {
          reasoning_content: 'Thinking only item from provider replay.',
        },
      },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
      { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'continue' }] },
    ],
  });

  t.deepEqual(body.input, [
    { role: 'user', type: 'message', content: 'start' },
    { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
    { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'continue' }] },
  ]);
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

test('createCustomProviderModelProvider uses OpencodeMinimaxHybridProvider for opencode type', async (t) => {
  const provider = createCustomProviderModelProvider(
    {
      ...baseConfig,
      type: 'opencode',
    },
    {
      defaultModel: 'some-model',
      fetch: async () => new Response('{}'),
    },
  );

  t.true(provider instanceof OpencodeMinimaxHybridProvider);

  // When model name contains minimax (case-insensitive), it should return model not using OpenAIProvider
  const minimaxModel = await provider.getModel('Minimax-3.5-Turbo');
  t.false(minimaxModel instanceof OpenAIChatCompletionsModel, 'minimax model should use Anthropic provider');

  // When model name does NOT contain minimax, it should return OpenAIChatCompletionsModel from OpenAIProvider
  const otherModel = await provider.getModel('other-model-name');
  t.true(otherModel instanceof OpenAIChatCompletionsModel, 'other model should use standard OpenAIProvider');
});
