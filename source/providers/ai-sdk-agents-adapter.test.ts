import { it, expect } from 'vitest';
import { withTrace } from '@openai/agents-core';
import { adaptAiSdkModelForAgents, withForwardedReasoningSettings } from './ai-sdk-agents-adapter.js';

function fakeV3Model(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'example.chat',
    modelId: 'example-model',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return { content: [], usage: {} };
    },
    async doStream() {
      return { stream: (async function* () {})() };
    },
    ...overrides,
  };
}

function modelRequest(overrides: Record<string, unknown> = {}) {
  return {
    input: 'hello',
    tools: [],
    handoffs: [],
    outputType: 'text',
    tracing: false,
    modelSettings: {},
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

it('withForwardedReasoningSettings forwards reasoning into providerData for non-stream requests', async () => {
  let seenRequest: any;
  const model = withForwardedReasoningSettings({
    async getResponse(request: any) {
      seenRequest = request;
      return { output: [], usage: {} };
    },
    async *getStreamedResponse() {},
  } as any);

  const originalRequest = {
    input: 'hi',
    modelSettings: {
      reasoning: { effort: 'high', summary: 'auto' },
      providerData: { service_tier: 'flex' },
    },
  };

  await model.getResponse(originalRequest as any);

  expect(seenRequest.modelSettings.providerData).toEqual({
    service_tier: 'flex',
    reasoning: { effort: 'high', summary: 'auto' },
  });
  expect(originalRequest.modelSettings.providerData).toEqual({ service_tier: 'flex' });
});

it('withForwardedReasoningSettings forwards reasoning into providerData for streamed requests', async () => {
  let seenRequest: any;
  const model = withForwardedReasoningSettings({
    async getResponse() {
      return { output: [], usage: {} };
    },
    async *getStreamedResponse(request: any) {
      seenRequest = request;
      yield;
    },
  } as any);

  for await (const _event of model.getStreamedResponse({
    input: 'hi',
    modelSettings: {
      reasoning: { effort: 'low', summary: 'auto' },
    },
  } as any)) {
    // Consume the stream.
  }

  expect(seenRequest.modelSettings.providerData).toEqual({
    reasoning: { effort: 'low', summary: 'auto' },
  });
});

it('withForwardedReasoningSettings preserves explicit providerData reasoning', async () => {
  let seenRequest: any;
  const providerReasoning = { effort: 'medium' };
  const model = withForwardedReasoningSettings({
    async getResponse(request: any) {
      seenRequest = request;
      return { output: [], usage: {} };
    },
    async *getStreamedResponse() {},
  } as any);

  await model.getResponse({
    input: 'hi',
    modelSettings: {
      reasoning: { effort: 'high', summary: 'auto' },
      providerData: { reasoning: providerReasoning },
    },
  } as any);

  expect(seenRequest.modelSettings.providerData.reasoning).toBe(providerReasoning);
});

it('adaptAiSdkModelForAgents makes reasoning visible to AI SDK doStream options', async () => {
  let seenOptions: any;
  const model = adaptAiSdkModelForAgents({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async () => ({ content: [], usage: {} }),
    doStream: async (options: any) => {
      seenOptions = options;
      return {
        stream: (async function* () {})(),
      };
    },
  });

  for await (const _event of model.getStreamedResponse({
    input: 'hi',
    tools: [],
    handoffs: [],
    outputType: 'text',
    modelSettings: {
      reasoning: { effort: 'high', summary: 'auto' },
    },
  } as any)) {
    // Consume the stream.
  }

  expect(seenOptions.reasoning).toEqual({ effort: 'high', summary: 'auto' });
});

it('adaptAiSdkModelForAgents forwards OpenRouter reasoning through providerOptions', async () => {
  let seenOptions: any;
  const model = adaptAiSdkModelForAgents({
    provider: 'openrouter.chat',
    modelId: 'openai/gpt-oss-120b',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async () => ({ content: [], usage: {} }),
    doStream: async (options: any) => {
      seenOptions = options;
      return {
        stream: (async function* () {})(),
      };
    },
  });

  for await (const _event of model.getStreamedResponse({
    input: 'hi',
    tools: [],
    handoffs: [],
    outputType: 'text',
    modelSettings: {
      reasoning: { effort: 'none', summary: 'auto' },
      providerData: { service_tier: 'flex' },
    },
  } as any)) {
    // Consume the stream.
  }

  expect(seenOptions.providerOptions.openrouter.reasoning).toEqual({
    effort: 'none',
    summary: 'auto',
  });
  expect(seenOptions.providerOptions.openrouter.service_tier).toBe('flex');
  expect(seenOptions.service_tier).toBe('flex');
});

it('adaptAiSdkModelForAgents forwards OpenRouter service tier without reasoning', async () => {
  let seenOptions: any;
  const model = adaptAiSdkModelForAgents({
    provider: 'openrouter.chat',
    modelId: 'openai/gpt-oss-120b',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async () => ({ content: [], usage: {} }),
    doStream: async (options: any) => {
      seenOptions = options;
      return {
        stream: (async function* () {})(),
      };
    },
  });

  for await (const _event of model.getStreamedResponse({
    input: 'hi',
    tools: [],
    handoffs: [],
    outputType: 'text',
    modelSettings: {
      providerData: { service_tier: 'flex' },
    },
  } as any)) {
    // Consume the stream.
  }

  expect(seenOptions.providerOptions.openrouter.service_tier).toBe('flex');
  expect('reasoning' in seenOptions.providerOptions.openrouter).toBe(false);
});

it('adaptAiSdkModelForAgents translates instructions, messages, tools, and a named tool choice', async () => {
  let seenOptions: any;
  const model = adaptAiSdkModelForAgents(
    fakeV3Model({
      async doGenerate(options: any) {
        seenOptions = options;
        return { content: [], usage: {} };
      },
    }) as any,
  );

  await withTrace('adapter-characterization', () =>
    model.getResponse(
      modelRequest({
        systemInstructions: 'Be concise.',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files.' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
        ],
        tools: [
          {
            type: 'function',
            name: 'list_files',
            description: 'Lists files.',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
            strict: true,
          },
        ],
        modelSettings: { toolChoice: 'list_files' },
      }) as any,
    ),
  );

  expect(seenOptions).toMatchObject({
    toolChoice: { type: 'tool', toolName: 'list_files' },
    tools: [
      {
        type: 'function',
        name: 'list_files',
        description: 'Lists files.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    prompt: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: [{ type: 'text', text: 'List files.' }], providerOptions: {} },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking.', providerOptions: {} }], providerOptions: {} },
    ],
  });
});

it('adaptAiSdkModelForAgents merges adjacent assistant messages before calling the AI SDK', async () => {
  let seenOptions: any;
  const model = adaptAiSdkModelForAgents(
    fakeV3Model({
      async doGenerate(options: any) {
        seenOptions = options;
        return { content: [], usage: {} };
      },
    }) as any,
  );

  await withTrace('adapter-characterization', () =>
    model.getResponse(
      modelRequest({
        input: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
          {
            type: 'function_call',
            callId: 'call-1',
            name: 'shell',
            arguments: '{"command":"pwd"}',
            status: 'completed',
          },
        ],
      }) as any,
    ),
  );

  expect(seenOptions.prompt).toEqual([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect it.', providerOptions: {} },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'shell', input: { command: 'pwd' }, providerOptions: {} },
      ],
      providerOptions: {},
    },
  ]);
});

it('adaptAiSdkModelForAgents preserves exact string tool arguments from a streamed AI SDK tool call', async () => {
  const model = adaptAiSdkModelForAgents(
    fakeV3Model({
      async doStream() {
        return {
          stream: (async function* () {
            yield {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'shell',
              input: '{"command":"printf(\\"  exact  \\")"}',
            };
          })(),
        };
      },
    }) as any,
  );

  const events = await collect(model.getStreamedResponse(modelRequest() as any));

  expect((events.at(-1) as any).response.output).toEqual([
    {
      type: 'function_call',
      callId: 'call-1',
      name: 'shell',
      arguments: '{"command":"printf(\\"  exact  \\")"}',
      status: 'completed',
      providerData: { model: 'example.chat:example-model' },
    },
  ]);
});

it('adaptAiSdkModelForAgents emits raw model events before derived text events and builds response_done authoritatively', async () => {
  const model = adaptAiSdkModelForAgents(
    fakeV3Model({
      async doStream() {
        return {
          stream: (async function* () {
            yield { type: 'response-metadata', id: 'response-1' };
            yield { type: 'reasoning-start', id: 'thought-1', providerMetadata: { anthropic: { signature: 'sig' } } };
            yield { type: 'reasoning-delta', id: 'thought-1', delta: 'Consider tools.' };
            yield { type: 'reasoning-end', id: 'thought-1' };
            yield { type: 'text-delta', delta: 'Done.' };
            yield { type: 'tool-call', toolCallId: 'call-1', toolName: 'shell', input: { command: 'pwd' } };
            yield { type: 'finish', usage: { inputTokens: 3, outputTokens: 5 } };
          })(),
        };
      },
    }) as any,
  );

  const events = await collect(model.getStreamedResponse(modelRequest() as any));

  expect(events.map((event: any) => event.type)).toEqual([
    'response_started',
    'model',
    'model',
    'model',
    'model',
    'model',
    'output_text_delta',
    'model',
    'model',
    'response_done',
  ]);
  expect((events.at(-1) as any).response).toEqual({
    id: 'response-1',
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    output: [
      {
        type: 'reasoning',
        id: 'thought-1',
        content: [{ type: 'input_text', text: 'Consider tools.' }],
        rawContent: [{ type: 'reasoning_text', text: 'Consider tools.' }],
        providerData: {
          model: 'example.chat:example-model',
          anthropic: { signature: 'sig' },
          responseId: 'response-1',
        },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
        status: 'completed',
        providerData: { model: 'example.chat:example-model', responseId: 'response-1' },
      },
      {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: '{"command":"pwd"}',
        status: 'completed',
        providerData: { model: 'example.chat:example-model', responseId: 'response-1' },
      },
    ],
  });
});

it('adaptAiSdkModelForAgents uses zero tokens for missing streamed usage without details', async () => {
  const model = adaptAiSdkModelForAgents(
    fakeV3Model({
      async doStream() {
        return {
          stream: (async function* () {
            yield { type: 'finish', usage: {} };
          })(),
        };
      },
    }) as any,
  );

  const events = await collect(model.getStreamedResponse(modelRequest() as any));

  expect((events.at(-1) as any).response.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

it('adaptAiSdkModelForAgents preserves zero and cached input usage details without inventing reasoning details', async () => {
  const model = adaptAiSdkModelForAgents(
    fakeV3Model({
      async doStream() {
        return {
          stream: (async function* () {
            yield {
              type: 'finish',
              usage: {
                inputTokens: { total: 0, cacheRead: 0, cacheWrite: 4 },
                outputTokens: { total: 0, reasoning: 7 },
              },
            };
          })(),
        };
      },
    }) as any,
  );

  const events = await collect(model.getStreamedResponse(modelRequest() as any));

  expect((events.at(-1) as any).response.usage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 4 },
  });
});

it('adaptAiSdkModelForAgents forwards AbortSignal and propagates cancellation from the streamed provider', async () => {
  let seenSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const cancelled = new Error('cancelled');
  const model = adaptAiSdkModelForAgents(
    fakeV3Model({
      async doStream(options: any) {
        seenSignal = options.abortSignal;
        return {
          stream: (async function* () {
            yield { type: 'text-delta', delta: 'first' };
            await new Promise<void>((resolve) =>
              options.abortSignal.addEventListener('abort', resolve, { once: true }),
            );
            throw cancelled;
          })(),
        };
      },
    }) as any,
  );

  const iterator = model
    .getStreamedResponse(modelRequest({ signal: controller.signal }) as any)
    [Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await iterator.next();
  const next = iterator.next();
  controller.abort();

  await expect(next).rejects.toBe(cancelled);
  expect(seenSignal).toBe(controller.signal);
});

it('adaptAiSdkModelForAgents propagates provider errors from generate and stream calls', async () => {
  const generateError = new Error('generate failed');
  const streamError = new Error('stream failed');
  const generatedModel = adaptAiSdkModelForAgents(
    fakeV3Model({
      async doGenerate() {
        throw generateError;
      },
    }) as any,
  );
  const streamedModel = adaptAiSdkModelForAgents(
    fakeV3Model({
      async doStream() {
        return {
          stream: (async function* () {
            throw streamError;
          })(),
        };
      },
    }) as any,
  );

  await expect(
    withTrace('adapter-characterization', () => generatedModel.getResponse(modelRequest() as any)),
  ).rejects.toBe(generateError);
  await expect(collect(streamedModel.getStreamedResponse(modelRequest() as any))).rejects.toBe(streamError);
});
