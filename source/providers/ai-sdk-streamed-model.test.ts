import { expect, it } from 'vitest';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

it('translates one application turn to an AI SDK stream and publishes its authoritative completion', async () => {
  let seenOptions: LanguageModelV3CallOptions | undefined;
  const signal = new AbortController().signal;
  const model = createAiSdkStreamedModel({
    provider: 'example.chat',
    modelId: 'example-model',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {} as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    async doStream(options: LanguageModelV3CallOptions) {
      seenOptions = options;
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'response-1' };
          yield { type: 'reasoning-start', id: 'thought-1', providerMetadata: { anthropic: { signature: 'sig' } } };
          yield { type: 'reasoning-delta', id: 'thought-1', delta: 'Think.' };
          yield { type: 'reasoning-end', id: 'thought-1', providerMetadata: { anthropic: { signature: 'final' } } };
          yield { type: 'text-delta', id: 'text-1', delta: 'Done.' };
          yield { type: 'tool-input-start', id: 'call-1', toolName: 'shell' };
          yield { type: 'tool-input-delta', id: 'call-1', delta: '{"command":' };
          yield { type: 'tool-input-delta', id: 'call-1', delta: '"pwd"}' };
          yield { type: 'tool-call', toolCallId: 'call-1', toolName: 'shell', input: '{"command":"pwd"}' };
          yield {
            type: 'finish',
            finishReason: { unified: 'tool-calls' },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 4 },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
            providerMetadata: { example: { request: 'metadata' } },
          };
        })(),
      } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as unknown as LanguageModelV3);

  const events = await collect(
    model.stream({
      instructions: 'Be concise.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'text', text: 'List files.' },
            { type: 'image', image: 'data:image/jpeg;base64,dXNlcg==' },
          ],
        },
        { type: 'message', role: 'assistant', content: [{ type: 'image', image: 'data:image/png;base64,aW1n' }] },
        { type: 'tool_call', id: 'old-call', name: 'shell', arguments: '{"command":"pwd"}' },
        {
          type: 'tool_result',
          id: 'old-call',
          output: [
            { type: 'text', text: 'ok' },
            { type: 'image', image: 'https://example.test/image.png' },
            { type: 'file', file: { url: 'file:///tmp/out', filename: 'out.txt' } },
          ],
        },
      ],
      tools: [{ name: 'shell', description: 'Run shell.', parameters: { type: 'object' }, strict: true }],
      toolChoice: { name: 'shell' },
      temperature: 0,
      topP: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxTokens: 0,
      outputType: {
        type: 'json_schema',
        name: 'result',
        strict: true,
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      reasoning: { effort: 'high' },
      providerOptions: { openrouter: { transforms: ['middle-out'] } },
      signal,
    }),
  );

  expect(seenOptions).toMatchObject({
    responseFormat: {
      type: 'json',
      name: 'result',
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    prompt: [
      { role: 'system', content: 'Be concise.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'List files.' },
          { type: 'file', data: 'data:image/jpeg;base64,dXNlcg==', mediaType: 'image/jpeg' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'file', data: 'data:image/png;base64,aW1n', mediaType: 'image/png' },
          { type: 'tool-call', toolCallId: 'old-call', toolName: 'shell', input: { command: 'pwd' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'old-call',
            toolName: 'shell',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'ok' },
                { type: 'image-url', url: 'https://example.test/image.png' },
                { type: 'file-url', url: 'file:///tmp/out' },
              ],
            },
          },
        ],
      },
    ],
    tools: [
      { type: 'function', name: 'shell', description: 'Run shell.', inputSchema: { type: 'object' }, strict: true },
    ],
    toolChoice: { type: 'tool', toolName: 'shell' },
    temperature: 0,
    topP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxOutputTokens: 0,
    providerOptions: { openrouter: { transforms: ['middle-out'] } },
    abortSignal: signal,
  });
  expect(events).toEqual([
    { type: 'reasoning_delta', id: 'thought-1', text: 'Think.', providerMetadata: { anthropic: { signature: 'sig' } } },
    { type: 'text_delta', text: 'Done.' },
    { type: 'tool_call_streaming_delta', toolName: 'shell', argumentCharCount: 11 },
    { type: 'tool_call_streaming_delta', toolName: 'shell', argumentCharCount: 17 },
    { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
    {
      type: 'completion',
      responseId: 'response-1',
      finishReason: 'tool-calls',
      usage: { inputTokens: 3, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 4 },
      providerMetadata: {
        example: { request: 'metadata' },
        model: 'example.chat:example-model',
        responseId: 'response-1',
      },
      output: [
        { type: 'reasoning', id: 'thought-1', text: 'Think.', providerMetadata: { anthropic: { signature: 'final' } } },
        { type: 'message', content: [{ type: 'text', text: 'Done.' }] },
        { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
      ],
    },
  ]);
});

it('preserves exact string tool arguments, streams live deltas, and propagates cancellation errors', async () => {
  let seenSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const cancelled = new Error('cancelled');
  const model = createAiSdkStreamedModel({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {} as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    async doStream(options: LanguageModelV3CallOptions) {
      seenSignal = options.abortSignal;
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'response-2' };
          yield { type: 'text-delta', id: 'text-1', delta: 'live' };
          await new Promise<void>((resolve) =>
            options.abortSignal?.addEventListener('abort', () => resolve(), { once: true }),
          );
          throw cancelled;
        })(),
      } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as unknown as LanguageModelV3);

  const iterator = model.stream({ input: [], tools: [], signal: controller.signal })[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text_delta', text: 'live' }, done: false });
  const next = iterator.next();
  controller.abort();
  await expect(next).rejects.toBe(cancelled);
  expect(seenSignal).toBe(controller.signal);
});

it('rejects provider errors and streams that cannot authoritatively complete', async () => {
  const providerError = new Error('provider error');
  const modelFor = (parts: readonly unknown[]) =>
    createAiSdkStreamedModel({
      provider: 'example',
      modelId: 'model',
      specificationVersion: 'v3',
      supportedUrls: {},
      async doGenerate() {
        return {} as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
      },
      async doStream() {
        return {
          stream: (async function* () {
            yield* parts;
          })(),
        } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
      },
    } as unknown as LanguageModelV3);

  await expect(
    collect(modelFor([{ type: 'error', error: providerError }]).stream({ input: [], tools: [] })),
  ).rejects.toBe(providerError);
  await expect(
    collect(
      modelFor([
        {
          type: 'finish',
          finishReason: { unified: 'stop' },
          usage: { inputTokens: {}, outputTokens: {} },
        },
      ]).stream({ input: [], tools: [] }),
    ),
  ).rejects.toThrow('response id');
  await expect(
    collect(modelFor([{ type: 'response-metadata', id: 'response-1' }]).stream({ input: [], tools: [] })),
  ).rejects.toThrow('without a finish event');
  await expect(
    collect(
      modelFor([
        { type: 'response-metadata', id: 'response-2' },
        {
          type: 'finish',
          finishReason: { unified: 'other' },
          usage: { inputTokens: {}, outputTokens: {} },
        },
      ]).stream({ input: [], tools: [] }),
    ),
  ).rejects.toThrow('without an authoritative native finish reason');
});

it('maps reasoning effort to Anthropic thinking provider options', async () => {
  let seenOptions: LanguageModelV3CallOptions | undefined;
  const model = createAiSdkStreamedModel({
    provider: 'anthropic.messages',
    modelId: 'claude-haiku',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {} as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    async doStream(options: LanguageModelV3CallOptions) {
      seenOptions = options;
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'anthropic-response' };
          yield { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: {}, outputTokens: {} } };
        })(),
      } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as unknown as LanguageModelV3);

  await collect(model.stream({ input: [], tools: [], reasoning: { effort: 'medium' } }));
  expect(seenOptions).toMatchObject({
    providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } } },
  });
  expect(seenOptions).not.toHaveProperty('reasoning');
});

it('maps reasoning effort to Google thinkingConfig and omits it when reasoning is disabled', async () => {
  let seenOptions: LanguageModelV3CallOptions | undefined;
  const model = createAiSdkStreamedModel({
    provider: 'google.generative-ai',
    modelId: 'gemini-2.5-flash',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {} as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    async doStream(options: LanguageModelV3CallOptions) {
      seenOptions = options;
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'google-response' };
          yield { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: {}, outputTokens: {} } };
        })(),
      } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as unknown as LanguageModelV3);

  await collect(model.stream({ input: [], tools: [], reasoning: { effort: 'high' } }));
  expect(seenOptions).toMatchObject({
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } } },
  });

  await collect(model.stream({ input: [], tools: [], reasoning: { effort: 'none' } }));
  expect(seenOptions).not.toHaveProperty('providerOptions.google.thinkingConfig');
});

it('preserves missing token totals without turning them into zero', async () => {
  const model = createAiSdkStreamedModel({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {} as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    async doStream() {
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'response-usage' };
          yield {
            type: 'finish',
            finishReason: { unified: 'stop' },
            usage: { inputTokens: {}, outputTokens: {} },
          };
        })(),
      } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as unknown as LanguageModelV3);

  const events = await collect(model.stream({ input: [], tools: [] }));

  expect(events).toEqual([
    {
      type: 'completion',
      responseId: 'response-usage',
      output: [],
      finishReason: 'stop',
      usage: {},
      providerMetadata: { model: 'example:model', responseId: 'response-usage' },
    },
  ]);
});

it('refuses to serialize a provider_opaque item through the AI SDK', async () => {
  const model = createAiSdkStreamedModel({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {} as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    async doStream() {
      throw new Error('should not be reached');
    },
  } as unknown as LanguageModelV3);

  await expect(
    collect(
      model.stream({
        input: [
          { type: 'provider_opaque', provider: 'openai', item: { type: 'compaction', encrypted_content: 'blob' } },
        ],
        tools: [],
      }),
    ),
  ).rejects.toThrow(/provider_opaque/);
});

it('AI SDK getResponse refuses a provider_opaque item', async () => {
  let generateCalls = 0;
  const model = createAiSdkStreamedModel({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      generateCalls += 1;
      throw new Error('should not be reached');
    },
    async doStream() {
      throw new Error('should not be reached');
    },
  } as unknown as LanguageModelV3);

  expect(typeof model.getResponse).toBe('function');
  await expect(
    model.getResponse!({
      input: [{ type: 'provider_opaque', provider: 'openai', item: { type: 'compaction', encrypted_content: 'blob' } }],
      tools: [],
    }),
  ).rejects.toThrow(/provider_opaque from 'openai'/);
  expect(generateCalls).toBe(0);
});
