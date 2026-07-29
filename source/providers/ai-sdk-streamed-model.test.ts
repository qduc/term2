import { expect, it } from 'vitest';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

it('translates one application turn to an AI SDK stream and publishes its authoritative completion', async () => {
  let seenOptions: any;
  const signal = new AbortController().signal;
  const model = createAiSdkStreamedModel({
    provider: 'example.chat',
    modelId: 'example-model',
    specificationVersion: 'v3',
    supportedUrls: {},
    async doGenerate() {
      return {} as any;
    },
    async doStream(options: any) {
      seenOptions = options;
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'response-1' };
          yield { type: 'reasoning-start', id: 'thought-1', providerMetadata: { anthropic: { signature: 'sig' } } };
          yield { type: 'reasoning-delta', id: 'thought-1', delta: 'Think.' };
          yield { type: 'reasoning-end', id: 'thought-1', providerMetadata: { anthropic: { signature: 'final' } } };
          yield { type: 'text-delta', id: 'text-1', delta: 'Done.' };
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
      };
    },
  } as any);

  const events = await collect(
    model.stream({
      instructions: 'Be concise.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'List files.' }] },
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
      reasoning: { effort: 'high' },
      providerOptions: { openrouter: { transforms: ['middle-out'] } },
      signal,
    }),
  );

  expect(seenOptions).toMatchObject({
    prompt: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: [{ type: 'text', text: 'List files.' }] },
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
      return {} as any;
    },
    async doStream(options: any) {
      seenSignal = options.abortSignal;
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'response-2' };
          yield { type: 'text-delta', id: 'text-1', delta: 'live' };
          await new Promise<void>((resolve) => options.abortSignal.addEventListener('abort', resolve, { once: true }));
          throw cancelled;
        })(),
      };
    },
  } as any);

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
        return {} as any;
      },
      async doStream() {
        return {
          stream: (async function* () {
            yield* parts;
          })(),
        };
      },
    } as any);

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
});
