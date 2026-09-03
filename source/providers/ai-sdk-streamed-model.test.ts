import { expect, it } from 'vitest';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function modelFor(parts: readonly unknown[]) {
  return createAiSdkStreamedModel({
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
          yield { type: 'response-metadata', id: 'response-test' };
          yield* parts;
        })(),
      } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as unknown as LanguageModelV3);
}

const testRequest = { input: [], tools: [] } as const;

it.each([
  ['a single space', ' '],
  ['four whitespace characters', '  \n\t'],
])('holds %s until a retryable provider error and emits no committed event', async (_label, whitespace) => {
  const error = Object.assign(new Error('upstream unavailable'), { status: 502 });
  await expect(
    collect(
      modelFor([
        { type: 'text-delta', delta: whitespace },
        { type: 'error', error },
      ]).stream(testRequest),
    ),
  ).rejects.toBe(error);
});

it('keeps an empty non-material frame from flushing leading whitespace before an error', async () => {
  const error = Object.assign(new Error('upstream unavailable'), { status: 502 });
  await expect(
    collect(
      modelFor([
        { type: 'text-delta', delta: ' ' },
        { type: 'text-delta', delta: '' },
        { type: 'error', error },
      ]).stream(testRequest),
    ),
  ).rejects.toBe(error);
});

it('does not commit leading whitespace before a non-retryable provider error either', async () => {
  const error = Object.assign(new Error('invalid request'), { status: 400 });
  await expect(
    collect(
      modelFor([
        { type: 'text-delta', delta: ' ' },
        { type: 'error', error },
      ]).stream(testRequest),
    ),
  ).rejects.toBe(error);
});

it('flushes leading whitespace before subsequent material text and preserves it', async () => {
  const events = await collect(
    modelFor([
      { type: 'text-delta', delta: ' ' },
      { type: 'text-delta', delta: 'hello' },
      { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: {}, outputTokens: {} } },
    ]).stream(testRequest),
  );
  expect(events).toEqual([
    { type: 'text_delta', text: ' ' },
    { type: 'text_delta', text: 'hello' },
    expect.objectContaining({
      type: 'completion',
      output: [{ type: 'message', content: [{ type: 'text', text: ' hello' }] }],
    }),
  ]);
});

it('flushes leading whitespace before a successful finish', async () => {
  const events = await collect(
    modelFor([
      { type: 'text-delta', delta: ' ' },
      { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: {}, outputTokens: {} } },
    ]).stream(testRequest),
  );
  expect(events).toEqual([
    { type: 'text_delta', text: ' ' },
    expect.objectContaining({
      type: 'completion',
      output: [{ type: 'message', content: [{ type: 'text', text: ' ' }] }],
    }),
  ]);
});

it('does not buffer a fifth leading whitespace character', async () => {
  const iterator = modelFor([
    { type: 'text-delta', delta: '    ' },
    { type: 'text-delta', delta: ' ' },
    { type: 'error', error: Object.assign(new Error('upstream unavailable'), { status: 502 }) },
  ])
    .stream(testRequest)
    [Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toEqual({ value: { type: 'text_delta', text: '    ' }, done: false });
  await expect(iterator.next()).resolves.toEqual({ value: { type: 'text_delta', text: ' ' }, done: false });
  await expect(iterator.next()).rejects.toMatchObject({ status: 502 });
});

it('keeps material text committed before an in-band error', async () => {
  const iterator = modelFor([
    { type: 'text-delta', delta: 'hello' },
    { type: 'text-delta', delta: ' ' },
    { type: 'error', error: Object.assign(new Error('upstream unavailable'), { status: 502 }) },
  ])
    .stream(testRequest)
    [Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toEqual({ value: { type: 'text_delta', text: 'hello' }, done: false });
  await expect(iterator.next()).resolves.toEqual({ value: { type: 'text_delta', text: ' ' }, done: false });
  await expect(iterator.next()).rejects.toMatchObject({ status: 502 });
});

it('flushes leading whitespace before reasoning and tool materiality', async () => {
  const reasoningIterator = modelFor([
    { type: 'text-delta', delta: ' ' },
    { type: 'reasoning-delta', id: 'thought', delta: 'think' },
    { type: 'error', error: Object.assign(new Error('upstream unavailable'), { status: 502 }) },
  ])
    .stream(testRequest)
    [Symbol.asyncIterator]();
  await expect(reasoningIterator.next()).resolves.toEqual({ value: { type: 'text_delta', text: ' ' }, done: false });
  await expect(reasoningIterator.next()).resolves.toEqual({
    value: { type: 'reasoning_delta', id: 'thought', text: 'think' },
    done: false,
  });
  await expect(reasoningIterator.next()).rejects.toMatchObject({ status: 502 });

  const toolIterator = modelFor([
    { type: 'text-delta', delta: ' ' },
    { type: 'tool-input-delta', id: 'call', delta: '{}' },
    { type: 'error', error: Object.assign(new Error('upstream unavailable'), { status: 502 }) },
  ])
    .stream(testRequest)
    [Symbol.asyncIterator]();
  await expect(toolIterator.next()).resolves.toEqual({ value: { type: 'text_delta', text: ' ' }, done: false });
  await expect(toolIterator.next()).resolves.toEqual({
    value: { type: 'tool_call_streaming_delta', argumentCharCount: 2 },
    done: false,
  });
  await expect(toolIterator.next()).rejects.toMatchObject({ status: 502 });
});

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

// A foreign opaque item is what a provider switch leaves behind. The AI SDK
// lane produces none of its own, so every one it sees belongs to another lane.
// Throwing used to kill every later turn too, because nothing removes the item
// from history.
it('drops a provider_opaque item and still sends the rest of the history', async () => {
  let capturedPrompt: any;
  const model = createAiSdkStreamedModel({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate(options: any) {
      capturedPrompt = options.prompt;
      return { content: [], finishReason: 'stop', usage: {} } as unknown as Awaited<
        ReturnType<LanguageModelV3['doGenerate']>
      >;
    },
    async doStream() {
      throw new Error('should not be reached');
    },
  } as unknown as LanguageModelV3);

  await model.getResponse!({
    input: [
      { type: 'provider_opaque', provider: 'openai', item: { type: 'compaction', encrypted_content: 'foreign-blob' } },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'still here' }] },
    ],
    tools: [],
  });

  expect(JSON.stringify(capturedPrompt)).not.toContain('foreign-blob');
  expect(capturedPrompt).toHaveLength(1);
  expect(capturedPrompt[0].role).toBe('user');
});

it('carries AI SDK outputTokens.reasoning through to completion usage', async () => {
  const model = createAiSdkStreamedModel({
    provider: 'openrouter',
    modelId: 'example/reasoning-model',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {
        response: { id: 'unary-reasoning' },
        text: 'visible',
        usage: { inputTokens: { total: 90 }, outputTokens: { total: 54, text: 2, reasoning: 52 } },
      } as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    async doStream() {
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'response-reasoning' };
          yield { type: 'text-delta', delta: 'visible' };
          yield {
            type: 'finish',
            finishReason: { unified: 'stop' },
            usage: { inputTokens: { total: 90 }, outputTokens: { total: 54, text: 2, reasoning: 52 } },
          };
        })(),
      } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as unknown as LanguageModelV3);

  const events = await collect(model.stream({ input: [], tools: [] }));
  const completion = events.find((e: any) => e.type === 'completion') as any;
  expect(completion.usage).toMatchObject({ inputTokens: 90, outputTokens: 54, reasoningTokens: 52 });

  const unary = await model.getResponse!({ input: [], tools: [] });
  expect(unary.usage).toMatchObject({ inputTokens: 90, outputTokens: 54, reasoningTokens: 52 });
});

it('extracts provider-reported cost from finish metadata and attaches costUsd to completion', async () => {
  const model = createAiSdkStreamedModel({
    provider: 'openrouter',
    modelId: 'anthropic/claude-3.5-sonnet',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {} as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    async doStream() {
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'response-cost' };
          yield { type: 'text-delta', delta: 'done' };
          yield {
            type: 'finish',
            finishReason: { unified: 'stop' },
            usage: { inputTokens: { total: 100 }, outputTokens: { total: 50 } },
            providerMetadata: {
              openrouter: {
                usage: {
                  promptTokens: 100,
                  completionTokens: 50,
                  totalTokens: 150,
                  cost: 0.00045,
                },
              },
            },
          };
        })(),
      } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as unknown as LanguageModelV3);

  const events = await collect(model.stream({ input: [], tools: [] }));
  const completion = events.find((e: any) => e.type === 'completion') as any;
  expect(completion).toBeDefined();
  expect(completion.costUsd).toBe(0.00045);
});

it('extracts provider-reported cost from unary getResponse providerMetadata', async () => {
  const model = createAiSdkStreamedModel({
    provider: 'openrouter',
    modelId: 'openai/gpt-4o',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {
        response: { id: 'unary-cost' },
        text: 'hello',
        usage: { inputTokens: { total: 50 }, outputTokens: { total: 20 } },
        providerMetadata: {
          openrouter: {
            usage: {
              cost: 0.00025,
            },
          },
        },
      } as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    async doStream() {
      throw new Error('not called');
    },
  } as unknown as LanguageModelV3);

  const result = await model.getResponse!({ input: [], tools: [] });
  expect(result.costUsd).toBe(0.00025);
  expect(result.providerMetadata).toBeDefined();
});

it('extracts upstream provider from stream completion providerMetadata', async () => {
  const model = createAiSdkStreamedModel({
    provider: 'openrouter',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not called');
    },
    async doStream() {
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'resp-1' };
          yield { type: 'text-delta', id: 't-1', delta: '1 2 3' };
          yield {
            type: 'finish',
            finishReason: { unified: 'stop' },
            usage: { inputTokens: { total: 18 }, outputTokens: { total: 6 } },
            providerMetadata: {
              openrouter: {
                provider: 'Novita',
              },
            },
          };
        })(),
      } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as unknown as LanguageModelV3);

  const events = await collect(model.stream({ input: [], tools: [] }));
  const completion = events.find((e: any) => e.type === 'completion') as any;
  expect(completion).toBeDefined();
  expect(completion.providerMetadata?.openrouter?.provider).toBe('Novita');
});
