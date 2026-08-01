import { it, expect } from 'vitest';
import {
  addAnthropicPromptCachingToMessages,
  AiSdkAnthropicProvider,
  getMaxOutputTokens,
} from './ai-sdk-anthropic.provider.js';

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

it('addAnthropicPromptCachingToMessages adds cacheControl to the last Anthropic message only', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'first' },
    { role: 'user', content: 'last' },
  ];

  const result = addAnthropicPromptCachingToMessages(messages, 'claude-sonnet-4-5');

  expect(result[0]).not.toBe(messages[0]);
  expect(result[1]).toEqual(messages[1]);
  expect(result[2]).not.toBe(messages[2]);
  expect(result[0].providerOptions).toEqual({
    anthropic: {
      cacheControl: { type: 'ephemeral' },
    },
  });
  expect(result[1].providerOptions).toBe(undefined);
  expect(result[2].providerOptions).toEqual({
    anthropic: {
      cacheControl: { type: 'ephemeral' },
    },
  });
});

it('addAnthropicPromptCachingToMessages adds cacheControl to last system user and tool messages', () => {
  const messages = [
    { role: 'system', content: 'system 1' },
    { role: 'user', content: 'user 1' },
    { role: 'tool', content: 'tool 1' },
    { role: 'assistant', content: 'assistant 1' },
    { role: 'system', content: 'system 2' },
    { role: 'user', content: 'user 2' },
    { role: 'tool', content: 'tool 2' },
  ];

  const result = addAnthropicPromptCachingToMessages(messages, 'claude-sonnet-4-5');

  expect(result[4].providerOptions).toEqual({
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  expect(result[5].providerOptions).toEqual({
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  expect(result[6].providerOptions).toEqual({
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  expect(result[0].providerOptions).toBe(undefined);
  expect(result[1].providerOptions).toBe(undefined);
  expect(result[2].providerOptions).toBe(undefined);
  expect(result[3].providerOptions).toBe(undefined);
});

it('addAnthropicPromptCachingToMessages preserves existing Anthropic providerOptions', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    {
      role: 'user',
      content: 'world',
      providerOptions: {
        anthropic: { topK: 5 },
        other: { enabled: true },
      },
    },
  ];

  const result = addAnthropicPromptCachingToMessages(messages, 'anthropic/claude-3-5-sonnet');

  expect(result[1].providerOptions).toEqual({
    anthropic: {
      topK: 5,
      cacheControl: { type: 'ephemeral' },
    },
    other: { enabled: true },
  });
});

it('addAnthropicPromptCachingToMessages leaves non-Anthropic models unchanged', () => {
  const messages = [{ role: 'user', content: 'hello' }];

  const result = addAnthropicPromptCachingToMessages(messages, 'gpt-4.1');

  expect(result).toBe(messages);
});

it('addAnthropicPromptCachingToMessages leaves qwen models unchanged by default', () => {
  const messages = [{ role: 'user', content: 'hello' }];

  const result = addAnthropicPromptCachingToMessages(messages, 'qwen3-coder');

  expect(result).toBe(messages);
});

it('addAnthropicPromptCachingToMessages supports provider-specific caching predicates', () => {
  const messages = [{ role: 'user', content: 'hello' }];

  const result = addAnthropicPromptCachingToMessages(messages, 'qwen3-coder', (modelId) => modelId.includes('qwen'));

  expect(result[0].providerOptions).toEqual({
    anthropic: {
      cacheControl: { type: 'ephemeral' },
    },
  });
});

it('AiSdkAnthropicProvider can be instantiated for Anthropic models', () => {
  const provider = new AiSdkAnthropicProvider({
    defaultModel: 'claude-sonnet-4-5',
    resolveConfig: () => ({
      apiKey: 'test-key',
      fetch: async () => new Response('{}'),
    }),
    createProvider: () => ((modelId: string) => ({ modelId })) as any,
  });

  expect(provider).toBeTruthy();
});

it('AiSdkAnthropicProvider routes its cached model through the application streamed turn', async () => {
  const fetchImpl = async () => new Response('{}');
  const configs: any[] = [];
  let requestedModel: string | undefined;
  let seenOptions: any;
  const provider = new AiSdkAnthropicProvider({
    defaultModel: 'claude-sonnet-4-5',
    resolveConfig: () => ({ apiKey: 'anthropic-key', baseURL: 'https://anthropic.test', fetch: fetchImpl }),
    shouldApplyPromptCaching: (modelId) => modelId === 'minimax-m3',
    createProvider: (config: any) => {
      configs.push(config);
      return (modelId: string) => {
        requestedModel = modelId;
        return {
          specificationVersion: 'v3',
          provider: 'anthropic.messages',
          modelId,
          supportedUrls: {},
          async doGenerate() {
            return {};
          },
          async doStream(options: any) {
            seenOptions = options;
            return {
              stream: (async function* () {
                yield { type: 'response-metadata', id: 'anthropic-response' };
                yield {
                  type: 'reasoning-start',
                  id: 'thought-1',
                  providerMetadata: { anthropic: { signature: 'start' } },
                };
                yield { type: 'reasoning-delta', id: 'thought-1', delta: 'Think.' };
                yield { type: 'reasoning-end', id: 'thought-1', providerMetadata: { anthropic: { signature: 'end' } } };
                yield { type: 'text-delta', delta: 'Done.' };
                yield { type: 'tool-call', toolCallId: 'call-1', toolName: 'shell', input: '{"command":"pwd"}' };
                yield {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls' },
                  usage: { inputTokens: { total: 3, cacheRead: 1 }, outputTokens: { total: 5 } },
                  providerMetadata: { anthropic: { request: 'metadata' } },
                };
              })(),
            };
          },
        } as any;
      };
    },
  });

  const model = await provider.getModel('minimax-m3');
  const controller = new AbortController();
  const events = await collect(
    model.getStreamedResponse({
      systemInstructions: 'Be concise.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files.' }] },
        {
          type: 'function_call',
          callId: 'previous-call',
          name: 'shell',
          arguments: '{"command":"ls"}',
          status: 'completed',
        },
        { type: 'function_call_result', callId: 'previous-call', name: 'shell', output: 'ok', status: 'completed' },
      ],
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      handoffs: [],
      outputType: 'text',
      modelSettings: {
        maxTokens: 1,
        reasoning: { effort: 'high' },
        providerData: {
          topK: 5,
          providerOptions: { anthropic: { topK: 9 } },
        },
      },
      signal: controller.signal,
    } as any),
  );

  expect(configs).toEqual([{ apiKey: 'anthropic-key', baseURL: 'https://anthropic.test', fetch: fetchImpl }]);
  expect(requestedModel).toBe('minimax-m3');
  expect(seenOptions).toMatchObject({
    maxOutputTokens: 131072,
    topK: 5,
    providerOptions: { anthropic: { topK: 9, thinking: { type: 'enabled', budgetTokens: 8192 } } },
    abortSignal: controller.signal,
  });
  expect(seenOptions.prompt).toMatchObject([
    { role: 'system', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
    { role: 'user', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
    { role: 'assistant' },
    { role: 'tool', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
  ]);
  expect(events.map((event: any) => event.type)).toEqual([
    'response_started',
    'model',
    'output_text_delta',
    'model',
    'response_done',
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'response_done',
    response: {
      id: 'anthropic-response',
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8, inputTokensDetails: [{ cached_tokens: 1 }] },
      providerData: {
        anthropic: { request: 'metadata' },
        model: 'anthropic.messages:minimax-m3',
        responseId: 'anthropic-response',
      },
      output: [
        {
          type: 'reasoning',
          id: 'thought-1',
          content: [{ type: 'input_text', text: 'Think.' }],
          providerData: { anthropic: { signature: 'end' } },
        },
        { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
        { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
      ],
    },
  });
});

it('AiSdkAnthropicProvider uses its default model and propagates provider errors', async () => {
  const providerError = new Error('provider error');
  let requestedModel: string | undefined;
  const provider = new AiSdkAnthropicProvider({
    defaultModel: 'claude-sonnet-4-5',
    resolveConfig: () => ({}),
    createProvider: () => (modelId: string) => {
      requestedModel = modelId;
      return {
        specificationVersion: 'v3',
        provider: 'anthropic.messages',
        modelId,
        supportedUrls: {},
        async doGenerate() {
          return {};
        },
        async doStream() {
          return {
            stream: (async function* () {
              yield { type: 'error', error: providerError };
            })(),
          };
        },
      } as any;
    },
  });

  const model = await provider.getModel();
  await expect(
    collect(
      model.getStreamedResponse({ input: 'hi', tools: [], handoffs: [], outputType: 'text', modelSettings: {} } as any),
    ),
  ).rejects.toBe(providerError);
  expect(requestedModel).toBe('claude-sonnet-4-5');
});

it('getMaxOutputTokens maps models correctly and defaults to 65536', () => {
  expect(getMaxOutputTokens('minimax-m3')).toBe(131072);
  expect(getMaxOutputTokens('qwen3.5-plus')).toBe(65536);
  expect(getMaxOutputTokens('deepseek-v4-flash')).toBe(384000);
  expect(getMaxOutputTokens('glm-5.1')).toBe(32768);
  expect(getMaxOutputTokens('anthropic/mimo-v2-omni')).toBe(128000);
  expect(getMaxOutputTokens('unknown-model')).toBe(65536);
  expect(getMaxOutputTokens('')).toBe(65536);
});
