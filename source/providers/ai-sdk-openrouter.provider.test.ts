import { it, expect } from 'vitest';
import { AiSdkOpenRouterProvider } from './ai-sdk-openrouter.provider.js';

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

it('AiSdkOpenRouterProvider creates an AI SDK model with OpenRouter settings', () => {
  const calls: any[] = [];
  let requestedModel: string | undefined;
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({
      baseURL: 'https://openrouter.test/api/v1',
      apiKey: 'sk-test',
      headers: {
        'HTTP-Referer': 'https://term2.test',
        'X-Title': 'term2',
      },
      appName: 'term2',
      appUrl: 'https://term2.test',
    }),
    createProvider: (options: any) => {
      calls.push(options);
      return (modelId: string) => {
        requestedModel = modelId;
        return {
          specificationVersion: 'v3',
          provider: 'openrouter.chat',
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({}),
          doStream: async () => ({ stream: [] }),
        } as any;
      };
    },
  });

  const model = provider.getStreamedModel('anthropic/claude-sonnet-4.5');

  expect(calls.length).toBe(1);
  expect(calls[0]).toMatchObject({
    baseURL: 'https://openrouter.test/api/v1',
    apiKey: 'sk-test',
    headers: {
      'HTTP-Referer': 'https://term2.test',
      'X-Title': 'term2',
    },
    appName: 'term2',
    appUrl: 'https://term2.test',
    compatibility: 'strict',
  });
  expect(requestedModel).toBe('anthropic/claude-sonnet-4.5');
  expect(typeof model.getResponse).toBe('function');
  expect(typeof model.stream).toBe('function');
});

it('AiSdkOpenRouterProvider uses the default model when none is requested', () => {
  let requestedModel: string | undefined;
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({}),
    createProvider: () => (modelId: string) => {
      requestedModel = modelId;
      return {
        specificationVersion: 'v3',
        provider: 'openrouter.chat',
        modelId,
        supportedUrls: {},
        doGenerate: async () => ({}),
        doStream: async () => ({ stream: [] }),
      } as any;
    },
  });

  provider.getStreamedModel();

  expect(requestedModel).toBe('openrouter/auto');
});

it('AiSdkOpenRouterProvider passes configured fetch to OpenRouter provider', () => {
  const fetchImpl = async () => new Response('{}');
  const calls: any[] = [];
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({
      fetch: fetchImpl,
    }),
    createProvider: (options: any) => {
      calls.push(options);
      return (modelId: string) =>
        ({
          specificationVersion: 'v3',
          provider: 'openrouter.chat',
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({}),
          doStream: async () => ({ stream: [] }),
        } as any);
    },
  });

  provider.getStreamedModel('selected-model');

  expect(calls[0].fetch).toBe(fetchImpl);
});

it('AiSdkOpenRouterProvider routes public Agent streams through the application turn and preserves OpenRouter options', async () => {
  const fetchImpl = async () => new Response('{}');
  let seenOptions: any;
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({ apiKey: 'sk-test', fetch: fetchImpl }),
    createProvider: (config: any) => {
      expect(config.fetch).toBe(fetchImpl);
      return (modelId: string) =>
        ({
          specificationVersion: 'v3',
          provider: 'openrouter.chat',
          modelId,
          supportedUrls: {},
          async doGenerate() {
            return {};
          },
          async doStream(options: any) {
            seenOptions = options;
            return {
              stream: (async function* () {
                yield { type: 'response-metadata', id: 'response-1' };
                yield { type: 'reasoning-start', id: 'thought-1', providerMetadata: { openrouter: { id: 'r1' } } };
                yield { type: 'reasoning-delta', id: 'thought-1', delta: 'Think.' };
                yield { type: 'reasoning-end', id: 'thought-1', providerMetadata: { openrouter: { id: 'r2' } } };
                yield { type: 'text-delta', delta: 'Done.' };
                yield { type: 'tool-call', toolCallId: 'call-1', toolName: 'shell', input: '{"command":"pwd"}' };
                yield {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls' },
                  usage: {
                    inputTokens: { total: 3, cacheRead: 1 },
                    outputTokens: { total: 5 },
                  },
                  providerMetadata: { openrouter: { request: 'metadata' } },
                };
              })(),
            };
          },
        } as any);
    },
  });

  const model = provider.getStreamedModel('openai/gpt-oss-120b');
  const events = await collect(
    model.stream({
      instructions: 'Be concise.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'List files.' }] }],
      tools: [{ name: 'shell', parameters: { type: 'object' } }],
      toolChoice: { name: 'shell' },
      temperature: 0,
      topP: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxTokens: 0,
      reasoning: { effort: 'none', summary: 'auto' },
      providerOptions: { service_tier: 'flex', providerOptions: { openrouter: { transforms: ['middle-out'] } } },
    }),
  );

  expect(seenOptions).toMatchObject({
    prompt: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: [{ type: 'text', text: 'List files.' }] },
    ],
    tools: [{ type: 'function', name: 'shell', inputSchema: { type: 'object' } }],
    toolChoice: { type: 'tool', toolName: 'shell' },
    temperature: 0,
    topP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxOutputTokens: 0,
    service_tier: 'flex',
    providerOptions: {
      openrouter: {
        service_tier: 'flex',
        transforms: ['middle-out'],
      },
    },
  });
  expect(events.map((event: any) => event.type)).toEqual(['reasoning_delta', 'text_delta', 'tool_call', 'completion']);
  expect(events.at(-1)).toMatchObject({
    type: 'completion',
    responseId: 'response-1',
    output: [
      { type: 'reasoning', id: 'thought-1', text: 'Think.', providerMetadata: { openrouter: { id: 'r2' } } },
      { type: 'message', content: [{ type: 'text', text: 'Done.' }] },
      { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
    ],
    providerMetadata: {
      openrouter: { request: 'metadata' },
      model: 'openrouter.chat:openai/gpt-oss-120b',
      responseId: 'response-1',
    },
    usage: { inputTokens: 3, outputTokens: 5, cachedInputTokens: 1 },
  });
});

it('AiSdkOpenRouterProvider preserves the stream signal and provider errors', async () => {
  const controller = new AbortController();
  const providerError = new Error('provider error');
  let seenSignal: AbortSignal | undefined;
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({}),
    createProvider: () => () =>
      ({
        specificationVersion: 'v3',
        provider: 'openrouter.chat',
        modelId: 'openrouter/auto',
        supportedUrls: {},
        async doGenerate() {
          return {};
        },
        async doStream(options: any) {
          seenSignal = options.abortSignal;
          return {
            stream: (async function* () {
              yield { type: 'text-delta', delta: 'before error' };
              throw providerError;
            })(),
          };
        },
      } as any),
  });

  const model = provider.getStreamedModel();
  await expect(
    collect(
      model.stream({
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
        signal: controller.signal,
      } as any),
    ),
  ).rejects.toBe(providerError);
  expect(seenSignal).toBe(controller.signal);
});

it('AiSdkOpenRouterProvider forwards explicit settings to unary getResponse and streaming calls', async () => {
  const calls: any[] = [];
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({}),
    createProvider: () => () =>
      ({
        specificationVersion: 'v3',
        provider: 'openrouter.chat',
        modelId: 'openrouter/auto',
        supportedUrls: {},
        async doGenerate(options: any) {
          calls.push({ operation: 'generate', options });
          return { response: { id: 'unary-response' }, text: 'unary', usage: { inputTokens: {}, outputTokens: {} } };
        },
        async doStream(options: any) {
          calls.push({ operation: 'stream', options });
          return {
            stream: (async function* () {
              yield { type: 'response-metadata', id: 'stream-response' };
              yield { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: {}, outputTokens: {} } };
            })(),
          };
        },
      } as any),
  });
  const model = provider.getStreamedModel();
  const request = {
    input: [{ type: 'message' as const, role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
    tools: [],
    providerOptions: { service_tier: 'flex', providerOptions: { openrouter: { transforms: ['middle-out'] } } },
  };

  await model.getResponse!(request);
  await collect(model.stream!(request));

  expect(calls.map((call) => call.operation)).toEqual(['generate', 'stream']);
  expect(calls.map((call) => call.options)).toEqual([
    expect.objectContaining({
      service_tier: 'flex',
      providerOptions: { openrouter: { service_tier: 'flex', transforms: ['middle-out'] } },
    }),
    expect.objectContaining({
      service_tier: 'flex',
      providerOptions: { openrouter: { service_tier: 'flex', transforms: ['middle-out'] } },
    }),
  ]);
});
