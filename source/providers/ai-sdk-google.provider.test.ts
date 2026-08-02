import { expect, it } from 'vitest';
import { ApplicationRunLoop } from '../services/agent-runtime/application-run-loop.js';
import { AiSdkGoogleProvider } from './ai-sdk-google.provider.js';

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

it('AiSdkGoogleProvider routes public Agent streams through the application turn and preserves Google settings', async () => {
  const fetchImpl = async () => new Response('{}');
  const calls: any[] = [];
  let requestedModel: string | undefined;
  let seenOptions: any;
  const provider = new AiSdkGoogleProvider({
    defaultModel: 'gemini-2.5-flash',
    resolveConfig: () => ({ apiKey: 'google-key', baseURL: 'https://google.test', fetch: fetchImpl }),
    createProvider: (config: any) => {
      calls.push(config);
      return (modelId: string) => {
        requestedModel = modelId;
        return {
          specificationVersion: 'v3',
          provider: 'google.generative-ai',
          modelId,
          supportedUrls: {},
          async doGenerate() {
            return {};
          },
          async doStream(options: any) {
            seenOptions = options;
            return {
              stream: (async function* () {
                yield { type: 'reasoning-start', id: 'thought-1', providerMetadata: { google: { id: 'r1' } } };
                yield { type: 'reasoning-delta', id: 'thought-1', delta: 'Think.' };
                yield { type: 'reasoning-end', id: 'thought-1', providerMetadata: { google: { id: 'r2' } } };
                yield { type: 'text-delta', delta: 'Done.' };
                yield { type: 'tool-call', toolCallId: 'call-1', toolName: 'shell', input: '{"command":"pwd"}' };
                yield {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls' },
                  usage: { inputTokens: { total: 3, cacheRead: 1 }, outputTokens: { total: 5 } },
                  providerMetadata: { google: { request: 'metadata' } },
                };
              })(),
            };
          },
        } as any;
      };
    },
  });

  const model = provider.getStreamedModel('gemini-2.5-pro');
  const controller = new AbortController();
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
      reasoning: { effort: 'medium', summary: 'auto' },
      providerOptions: {
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
        providerOptions: { google: { responseModalities: ['TEXT'], safetySettings: ['nested wins'] } },
      },
      signal: controller.signal,
    } as any),
  );

  expect(calls).toEqual([{ apiKey: 'google-key', baseURL: 'https://google.test', fetch: fetchImpl }]);
  expect(requestedModel).toBe('gemini-2.5-pro');
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
    safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
    providerOptions: {
      google: {
        safetySettings: ['nested wins'],
        responseModalities: ['TEXT'],
        thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
      },
    },
    abortSignal: controller.signal,
  });
  expect(events.map((event: any) => event.type)).toEqual(['reasoning_delta', 'text_delta', 'tool_call', 'completion']);
  expect(events.at(-1)).toMatchObject({
    type: 'completion',
    responseId: 'FAKE_ID',
    output: [
      { type: 'reasoning', id: 'thought-1', text: 'Think.', providerMetadata: { google: { id: 'r2' } } },
      { type: 'message', content: [{ type: 'text', text: 'Done.' }] },
      { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
    ],
    providerMetadata: {
      google: { request: 'metadata' },
      model: 'google.generative-ai:gemini-2.5-pro',
      responseId: 'FAKE_ID',
    },
    usage: { inputTokens: 3, outputTokens: 5, cachedInputTokens: 1 },
  });
  const completion = events.at(-1) as any;
  expect(completion.usage.inputTokens).toBe(3);
  expect(completion.usage.outputTokens).toBe(5);
  expect(completion.usage.cachedInputTokens).toBe(1);
});

it('applies thinkingConfig to a custom-named Google model through the application run loop', async () => {
  let seenOptions: any;
  const provider = new AiSdkGoogleProvider({
    defaultModel: 'gemini-2.5-flash',
    resolveConfig: () => ({ name: 'gemini' }),
    createProvider: () => (modelId: string) =>
      ({
        specificationVersion: 'v3',
        // createGoogleGenerativeAI uses the configured provider name as this
        // prefix; this is the production shape for the custom `gemini` provider.
        provider: 'gemini.generative-ai',
        modelId,
        supportedUrls: {},
        async doGenerate() {
          return {};
        },
        async doStream(options: any) {
          seenOptions = options;
          return {
            stream: (async function* () {
              yield { type: 'text-delta', delta: 'gemini-ok' };
              yield {
                type: 'finish',
                finishReason: { unified: 'stop' },
                usage: { inputTokens: {}, outputTokens: {} },
              };
            })(),
          };
        },
      } as any),
  });
  const stream = new ApplicationRunLoop({ resolveModel: () => provider.getStreamedModel() }).startStream(
    {
      name: 'test-agent',
      instructions: 'Be concise.',
      model: 'gemini-2.5-flash',
      modelSettings: {
        reasoning: { effort: 'medium' },
        providerData: { google: { responseModalities: ['TEXT'] } },
      },
      tools: [],
    },
    'Reply with exactly: gemini-ok',
  );

  await collect(stream);
  await stream.completed;

  expect(stream.finalOutput).toBe('gemini-ok');
  expect(seenOptions).toMatchObject({
    providerOptions: {
      google: {
        responseModalities: ['TEXT'],
        thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
      },
    },
  });
});

it('AiSdkGoogleProvider uses its default model and propagates provider errors', async () => {
  const providerError = new Error('provider error');
  let requestedModel: string | undefined;
  const provider = new AiSdkGoogleProvider({
    defaultModel: 'gemini-2.5-flash',
    resolveConfig: () => ({}),
    createProvider: () => (modelId: string) => {
      requestedModel = modelId;
      return {
        specificationVersion: 'v3',
        provider: 'google.generative-ai',
        modelId,
        supportedUrls: {},
        async doGenerate() {
          return {};
        },
        async doStream() {
          return {
            stream: (async function* () {
              yield { type: 'text-delta', delta: 'before error' };
              throw providerError;
            })(),
          };
        },
      } as any;
    },
  });

  const model = provider.getStreamedModel();
  await expect(
    collect(
      model.stream({ input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }),
    ),
  ).rejects.toBe(providerError);
  expect(requestedModel).toBe('gemini-2.5-flash');
});
