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

it('AiSdkOpenRouterProvider surfaces OpenRouter cost metadata as costUsd on completion', async () => {
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({ apiKey: 'sk-test' }),
    createProvider: () => (modelId: string) =>
      ({
        specificationVersion: 'v3',
        provider: 'openrouter.chat',
        modelId,
        supportedUrls: {},
        async doGenerate() {
          return {
            response: { id: 'resp-gen' },
            text: 'hi',
            usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
            providerMetadata: {
              openrouter: {
                usage: {
                  promptTokens: 10,
                  completionTokens: 5,
                  totalTokens: 15,
                  cost: 0.00012,
                },
              },
            },
          };
        },
        async doStream() {
          return {
            stream: (async function* () {
              yield { type: 'response-metadata', id: 'resp-stream' };
              yield { type: 'text-delta', delta: 'hi' };
              yield {
                type: 'finish',
                finishReason: { unified: 'stop' },
                usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
                providerMetadata: {
                  openrouter: {
                    usage: {
                      promptTokens: 10,
                      completionTokens: 5,
                      totalTokens: 15,
                      cost: 0.00012,
                    },
                  },
                },
              };
            })(),
          };
        },
      } as any),
  });

  const model = provider.getStreamedModel('openai/gpt-4o-mini');
  const unary = await model.getResponse!({ input: [], tools: [] });
  expect(unary.costUsd).toBe(0.00012);

  const streamEvents = await collect(model.stream!({ input: [], tools: [] }));
  const completion = streamEvents.find((e: any) => e.type === 'completion') as any;
  expect(completion).toBeDefined();
  expect(completion.costUsd).toBe(0.00012);
});

const reasoningFixtureResponse = {
  id: 'mock-1',
  created: 0,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

function createRealSdkOpenRouterProvider(capturedBodies: any[], modelName: string = 'z-ai/glm-5.3-flash') {
  return new AiSdkOpenRouterProvider({
    defaultModel: modelName,
    resolveConfig: () => ({
      apiKey: 'sk-fake',
      baseURL: 'https://openrouter.test/api/v1',
      fetch: (async (_input: unknown, init?: { body?: string }) => {
        capturedBodies.push(JSON.parse(init?.body ?? '{}'));
        return new Response(JSON.stringify({ ...reasoningFixtureResponse, model: modelName }), {
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    }),
  });
}

async function generateWithReasoning(
  request: Record<string, unknown>,
  modelName: string = 'z-ai/glm-5.3-flash',
): Promise<any> {
  const capturedBodies: any[] = [];
  const provider = createRealSdkOpenRouterProvider(capturedBodies, modelName);
  const model = provider.getStreamedModel(modelName);
  await model.getResponse!({
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 100,
    ...request,
  } as any);
  expect(capturedBodies.length).toBe(1);
  expect(capturedBodies[0]).toMatchObject({
    model: modelName,
    max_tokens: 100,
  });
  return capturedBodies[0];
}

it.each([
  ['low', { effort: 'low' }],
  ['high', { effort: 'high' }],
])('AiSdkOpenRouterProvider forwards native reasoning effort %s to OpenRouter', async (_name, reasoning) => {
  const body = await generateWithReasoning({ reasoning });
  expect(body.reasoning).toEqual(reasoning);
});

it('AiSdkOpenRouterProvider forwards native reasoning effort none on an optional-reasoning model to OpenRouter', async () => {
  const body = await generateWithReasoning({ reasoning: { effort: 'none' } }, 'openai/gpt-5.1');
  expect(body.reasoning).toEqual({ effort: 'none' });
});

it('AiSdkOpenRouterProvider omits the reasoning control for native default effort', async () => {
  const body = await generateWithReasoning({ reasoning: { effort: 'default' } });
  expect(body.reasoning).toBeUndefined();
});

it('AiSdkOpenRouterProvider gives explicit nested SDK providerOptions.openrouter.reasoning precedence over native reasoning', async () => {
  const body = await generateWithReasoning({
    reasoning: { effort: 'low' },
    providerOptions: { providerOptions: { openrouter: { reasoning: { effort: 'high' } } } },
  });
  expect(body.reasoning).toEqual({ effort: 'high' });
});

it('AiSdkOpenRouterProvider gives explicit top-level legacy providerOptions.reasoning precedence over native reasoning', async () => {
  const body = await generateWithReasoning({
    reasoning: { effort: 'low' },
    providerOptions: { reasoning: { effort: 'high' } },
  });
  expect(body.reasoning).toEqual({ effort: 'high' });
});

it('AiSdkOpenRouterProvider gives explicit direct SDK providerOptions.openrouter precedence over native reasoning and preserves other openrouter fields', async () => {
  const capturedBodies: any[] = [];
  const provider = createRealSdkOpenRouterProvider(capturedBodies);
  const model = provider.getStreamedModel('z-ai/glm-5.3-flash');
  await model.getResponse!({
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 100,
    reasoning: { effort: 'low' },
    providerOptions: {
      openrouter: { reasoning: { effort: 'high' }, transforms: ['middle-out'] },
    },
  } as any);
  expect(capturedBodies.length).toBe(1);
  expect(capturedBodies[0].reasoning).toEqual({ effort: 'high' });
  expect(capturedBodies[0].transforms).toEqual(['middle-out']);
});

it.each([
  ['none', { effort: 'none' }],
  ['medium', { effort: 'medium' }],
])(
  'AiSdkOpenRouterProvider surfaces the provider rejection for unsupported effort %s on a mandatory model',
  async (_name, reasoning) => {
    const capturedBodies: any[] = [];
    const provider = new AiSdkOpenRouterProvider({
      defaultModel: 'z-ai/glm-5.3-flash',
      resolveConfig: () => ({
        apiKey: 'sk-fake',
        baseURL: 'https://openrouter.test/api/v1',
        fetch: (async (_input: unknown, init?: { body?: string }) => {
          const body = JSON.parse(init?.body ?? '{}') as { reasoning?: { effort?: string } };
          capturedBodies.push(body);
          if (body.reasoning?.effort === reasoning.effort) {
            return new Response(
              JSON.stringify({
                error: {
                  message: 'Unsupported reasoning effort for mandatory model; supported: max, high, low',
                  code: 400,
                },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(JSON.stringify({ ...reasoningFixtureResponse, model: 'z-ai/glm-5.3-flash' }), {
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      }),
    });
    const model = provider.getStreamedModel('z-ai/glm-5.3-flash');
    let error: any;
    try {
      await model.getResponse!({
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
        maxTokens: 100,
        reasoning,
      } as any);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(String(error.message ?? error)).toContain('supported: max, high, low');
    expect(capturedBodies.length).toBe(1);
    expect(capturedBodies[0].reasoning).toEqual(reasoning);
  },
);
