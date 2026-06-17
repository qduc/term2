import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { withTrace } from '@openai/agents-core';
import { OpenAIProvider, OpenAIChatCompletionsModel, OpenAIResponsesModel } from '@openai/agents-openai';

import {
  createCustomProviderModelProvider,
  sanitizeResponsesApiBody,
  type CustomProviderConfig,
  OpencodeAnthropicFormatProvider,
} from './openai-compatible.provider.js';
import { AiSdkAnthropicProvider } from './ai-sdk-anthropic.provider.js';
import { AiSdkGoogleProvider } from './ai-sdk-google.provider.js';

const baseConfig = {
  name: 'custom-provider',
  baseUrl: 'https://example.test',
  apiKey: 'test-key',
} satisfies CustomProviderConfig;

it('createCustomProviderModelProvider uses native chat-completions OpenAIProvider by default', async () => {
  const provider = createCustomProviderModelProvider(baseConfig, {
    defaultModel: 'model-a',
    fetch: async () => new Response('{}'),
  });

  expect(provider instanceof OpenAIProvider).toBe(true);
  const model = await (provider as OpenAIProvider).getModel('model-a');
  expect(model instanceof OpenAIChatCompletionsModel).toBe(true);
});

it('createCustomProviderModelProvider uses native responses OpenAIProvider for openai type', async () => {
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

  expect(provider instanceof OpenAIProvider).toBe(true);
  const model = await (provider as OpenAIProvider).getModel('model-a');
  expect(model instanceof OpenAIResponsesModel).toBe(true);
});

it('sanitizeResponsesApiBody preserves empty replayed response messages that still carry reasoning', () => {
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

  expect(body.input).toEqual([
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
  ]);
});

it('createCustomProviderModelProvider uses Anthropic adapter for anthropic type', () => {
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

  expect(provider instanceof AiSdkAnthropicProvider).toBe(true);
});

it('createCustomProviderModelProvider uses Google adapter for google type', () => {
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

  expect(provider instanceof AiSdkGoogleProvider).toBe(true);
});

it('createCustomProviderModelProvider Google type gets logging fetch wrapper', async () => {
  const loggedEvents: any[] = [];
  const dummyLoggingService = {
    debug: (msg: string, meta?: any) => {
      loggedEvents.push({ msg, meta });
    },
    error: () => {},
    getCorrelationId: () => 'test-correlation-id',
  };
  const dummySessionContextService = {
    getContext: () => ({
      traceId: 'test-trace-id',
      sessionId: 'test-session-id',
      sessionStartedAt: '12345',
      firstUserMessagePreview: 'hello',
      mode: 'standard',
    }),
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
  };

  const provider = createCustomProviderModelProvider(
    {
      ...baseConfig,
      type: 'google',
    },
    {
      defaultModel: 'gemini-test',
      loggingService: dummyLoggingService as any,
      sessionContextService: dummySessionContextService as any,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'Hello from mock Gemini!' }],
                  role: 'model',
                },
                finishReason: 'STOP',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }) as typeof fetch,
    },
  );

  expect(provider instanceof AiSdkGoogleProvider).toBe(true);

  const model = await provider.getModel('gemini-test');
  await withTrace('test', () =>
    model.getResponse({
      tools: [],
      handoffs: [],
      outputType: 'text' as const,
      tracing: false as const,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {},
    } as any),
  );

  // Verify that the request started event was logged by the logging middleware
  const requestStartedEvent = loggedEvents.find((e) => e.meta?.eventType === 'provider.request.started');
  expect(requestStartedEvent).toBeTruthy();
  expect(requestStartedEvent.meta.provider).toBe('custom-provider');
  expect(requestStartedEvent.meta.model).toBe('gemini-test');
});

it('createCustomProviderModelProvider uses OpencodeAnthropicFormatProvider for opencode type', async () => {
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

  expect(provider instanceof OpencodeAnthropicFormatProvider).toBe(true);

  // When model name contains minimax (case-insensitive), it should return model not using OpenAIProvider
  const minimaxModel = await provider.getModel('Minimax-3.5-Turbo');
  expect(minimaxModel instanceof OpenAIChatCompletionsModel).toBe(false);

  // When model name does NOT contain minimax, it should return OpenAIChatCompletionsModel from OpenAIProvider
  const otherModel = await provider.getModel('other-model-name');
  expect(otherModel instanceof OpenAIChatCompletionsModel).toBe(true);
});
