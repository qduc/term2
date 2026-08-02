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

  const model = provider.getModel('anthropic/claude-sonnet-4.5');

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
  expect(typeof (model as any).getResponse).toBe('function');
  expect(typeof (model as any).getStreamedResponse).toBe('function');
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

  provider.getModel();

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

  provider.getModel('selected-model');

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

  const model = await provider.getModel('openai/gpt-oss-120b');
  const events = await collect(
    model.getStreamedResponse({
      systemInstructions: 'Be concise.',
      input: 'List files.',
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      handoffs: [],
      outputType: 'text',
      modelSettings: {
        toolChoice: 'shell',
        temperature: 0,
        topP: 0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        maxTokens: 0,
        reasoning: { effort: 'none', summary: 'auto' },
        providerData: { service_tier: 'flex', providerOptions: { openrouter: { transforms: ['middle-out'] } } },
      },
    } as any),
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
  expect(events.map((event: any) => event.type)).toEqual([
    'response_started',
    'model',
    'output_text_delta',
    'model',
    'response_done',
  ]);
  const response = (events.at(-1) as any).response;
  expect(response).toMatchObject({
    id: 'response-1',
    output: [
      {
        type: 'reasoning',
        id: 'thought-1',
        content: [{ type: 'input_text', text: 'Think.' }],
        rawContent: [{ type: 'reasoning_text', text: 'Think.' }],
        providerData: {
          openrouter: { id: 'r2' },
        },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
        status: 'completed',
      },
      { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{"command":"pwd"}', status: 'completed' },
    ],
    providerData: {
      openrouter: { request: 'metadata' },
      model: 'openrouter.chat:openai/gpt-oss-120b',
      responseId: 'response-1',
    },
  });
  expect(response.usage.inputTokens).toBe(3);
  expect(response.usage.outputTokens).toBe(5);
  expect(response.usage.totalTokens).toBe(8);
  expect(response.usage.inputTokensDetails).toEqual([{ cached_tokens: 1 }]);
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

  const model = await provider.getModel();
  await expect(
    collect(
      model.getStreamedResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        outputType: 'text',
        modelSettings: {},
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
