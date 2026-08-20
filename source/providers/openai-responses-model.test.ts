import { it, expect, vi } from 'vitest';
import {
  prepareOpenAIRequestPrefixBinding,
  runWithOpenAIRequestPrefixBindingScope,
} from './openai-request-prefix-binding.js';

// The real ResponsesWS opens an actual WebSocket in its constructor. Mock the
// module so the websocket-transport tests below can drive `.stream()` without
// touching the network; each test overrides `fakeResponsesWSStream` first.
let fakeResponsesWSStream: () => AsyncIterable<any> = async function* () {};
let capturedWSRequest: any;
vi.mock('openai/resources/responses/ws', () => ({
  ResponsesWS: class {
    send(body: any) {
      capturedWSRequest = body;
    }
    close() {}
    stream() {
      return fakeResponsesWSStream();
    }
  },
}));

const {
  OpenAIResponsesModelWithPromptCacheKey,
  OpenAIResponsesWSModelWithPromptCacheKey,
  normalizeResponseEvent,
  createResponseEventNormalizationState,
} = await import('./openai-responses-model.js');

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

it('settles a terminal response when the retained WebSocket iterator never closes', async () => {
  let emittedCompletion = false;
  fakeResponsesWSStream = () => ({
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (!emittedCompletion) {
            emittedCompletion = true;
            return {
              done: false,
              value: { type: 'message', message: { type: 'response.completed', response: { id: 'ws-terminal' } } },
            };
          }
          return new Promise<IteratorResult<any>>(() => undefined);
        },
        return: () => new Promise<IteratorResult<any>>(() => undefined),
      };
    },
  });
  const model = new OpenAIResponsesWSModelWithPromptCacheKey(
    { responses: { create: async () => ({}) } },
    'gpt-5.6-luna',
  );

  const result = await Promise.race([
    collect(model.stream({ input: [], tools: [] })).then(() => 'settled' as const),
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);

  expect(result).toBe('settled');
});

it('normalizes streamed Responses tool argument progress for the UI', () => {
  const state = createResponseEventNormalizationState();
  expect(
    normalizeResponseEvent(
      {
        type: 'response.output_item.added',
        output_index: 0,
        output_item: { type: 'function_call', name: 'shell', id: 'call-1' },
      },
      state,
    ),
  ).toBeNull();
  expect(
    normalizeResponseEvent(
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"command":' },
      state,
    ),
  ).toEqual({ type: 'tool_call_streaming_delta', toolName: 'shell', argumentCharCount: 11 });
  expect(
    normalizeResponseEvent({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '"pwd"}' }, state),
  ).toEqual({ type: 'tool_call_streaming_delta', toolName: 'shell', argumentCharCount: 17 });
});

it('normalizes response.reasoning_text.delta as a live reasoning delta (opencode variant)', () => {
  const state = createResponseEventNormalizationState();
  expect(
    normalizeResponseEvent({ type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: 'Thinking' }, state),
  ).toEqual({ type: 'reasoning_delta', id: 'rs_1', text: 'Thinking' });
  expect(
    normalizeResponseEvent({ type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: ' harder.' }, state),
  ).toEqual({ type: 'reasoning_delta', id: 'rs_1', text: ' harder.' });
});

it('surfaces reasoning_summary_part text without double-counting a later summary', () => {
  const state = createResponseEventNormalizationState();
  // Empty part marker carries no text and emits nothing.
  expect(
    normalizeResponseEvent(
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs_1',
        part: { type: 'summary_text', text: '' },
      },
      state,
    ),
  ).toBeNull();
  // Non-empty part text is emitted exactly once per reasoning item.
  expect(
    normalizeResponseEvent(
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs_1',
        part: { type: 'summary_text', text: 'brief thought' },
      },
      state,
    ),
  ).toEqual({ type: 'reasoning_delta', id: 'rs_1', text: 'brief thought' });
  // The terminal summary part must not re-emit text already shown.
  expect(
    normalizeResponseEvent(
      {
        type: 'response.reasoning_summary_part.done',
        item_id: 'rs_1',
        part: { type: 'summary_text', text: 'brief thought' },
      },
      state,
    ),
  ).toBeNull();
});

it('emits each reasoning summary-part delta while suppressing the repeated done text', () => {
  const state = createResponseEventNormalizationState();
  expect(
    normalizeResponseEvent(
      { type: 'response.reasoning_summary_part.delta', item_id: 'rs_1', part: { text: 'first ' } },
      state,
    ),
  ).toEqual({ type: 'reasoning_delta', id: 'rs_1', text: 'first ' });
  expect(
    normalizeResponseEvent(
      { type: 'response.reasoning_summary_part.delta', item_id: 'rs_1', part: { text: 'second' } },
      state,
    ),
  ).toEqual({ type: 'reasoning_delta', id: 'rs_1', text: 'second' });
  expect(
    normalizeResponseEvent(
      { type: 'response.reasoning_summary_part.done', item_id: 'rs_1', part: { text: 'first second' } },
      state,
    ),
  ).toBeNull();
});

it('surfaces a completed function_call item as a streaming delta when args arrive wholesale (opencode variant)', () => {
  const state = createResponseEventNormalizationState();
  expect(
    normalizeResponseEvent(
      {
        type: 'response.output_item.added',
        output_index: 0,
        output_item: { type: 'function_call', name: 'shell', id: 'call-1' },
      },
      state,
    ),
  ).toBeNull();
  // Opencode may deliver the full arguments only on the done frame.
  expect(
    normalizeResponseEvent(
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'call-1',
        arguments: '{"command":"pwd"}',
      },
      state,
    ),
  ).toEqual({ type: 'tool_call_streaming_delta', toolName: 'shell', argumentCharCount: 17 });
  expect(
    normalizeResponseEvent(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'call-1', call_id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
      },
      state,
    ),
  ).toBeNull();
});

it('does not emit streaming deltas for non-function output items', () => {
  const state = createResponseEventNormalizationState();
  expect(
    normalizeResponseEvent(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'm-1', content: [{ type: 'output_text', text: 'hello' }] },
      },
      state,
    ),
  ).toBeNull();
});

it('normalizes only completed Responses events as successful completions', () => {
  expect(normalizeResponseEvent({ type: 'response.completed', response: { id: 'done', output: [] } })).toEqual({
    type: 'completion',
    responseId: 'done',
    output: [],
    usage: undefined,
  });
  expect(() =>
    normalizeResponseEvent({
      type: 'response.failed',
      response: { id: 'bad', status: 'failed', error: { message: 'quota' } },
    }),
  ).toThrow('response.failed (quota)');
  expect(() =>
    normalizeResponseEvent({ type: 'response.incomplete', response: { id: 'partial', status: 'incomplete' } }),
  ).toThrow('response.incomplete (incomplete)');
  expect(() =>
    normalizeResponseEvent({
      type: 'response.incomplete',
      response: {
        id: 'partial',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    }),
  ).toThrow('response.incomplete (max_output_tokens)');
});

it('getResponse (HTTP) preserves typed settings, including zero values, in the native body', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_settings', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await model.getResponse({
    input: [],
    tools: [],
    toolChoice: { name: 'shell' },
    topP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 0,
  });

  expect(capturedBody).toMatchObject({
    tool_choice: { type: 'function', name: 'shell' },
    top_p: 0,
    frequency_penalty: 0,
    presence_penalty: 0,
    max_output_tokens: 0,
  });
  expect(capturedBody.include).toEqual(['reasoning.encrypted_content']);
  expect(capturedBody).not.toHaveProperty('prompt_cache_key');
});

it.each([
  ['gpt-5.4-mini', 200_000],
  ['gpt-5.5', 136_000],
  ['gpt-5.6-luna', 136_000],
  ['gpt-5.6-terra', 136_000],
  ['gpt-5.6-sol', 136_000],
  ['gpt-5.3-codex', 200_000],
  ['gpt-5.3-codex-spark', 64_000],
])('converts the context compaction ratio to model tokens (%s)', async (modelName, expectedThreshold) => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_compaction', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, modelName, undefined, true);
  await model.getResponse({
    input: [],
    tools: [],
    providerOptions: { contextCompaction: { enabled: true, threshold: 0.5 } },
  });

  expect(capturedBody.context_management).toEqual([{ type: 'compaction', compact_threshold: expectedThreshold }]);
});

it('uses the earlier of ratio and raw-token context compaction thresholds', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_compaction', output: [], usage: {} };
      },
    },
  };
  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.4-nano', undefined, true);

  await model.getResponse({
    input: [],
    tools: [],
    providerOptions: { contextCompaction: { enabled: true, threshold: 0.8, thresholdTokens: 120_000 } },
  });

  expect(capturedBody.context_management).toEqual([{ type: 'compaction', compact_threshold: 120_000 }]);
});

it.each([
  ['unsupported model', 'gpt-5.3', true],
  ['pre-5.4 auto-compact 500 family', 'gpt-5.2', true],
  ['unmeasured future model', 'gpt-5.10', true],
  ['non-OpenAI provider capability', 'gpt-5.4-mini', false],
])('does not send context management for an enabled %s', async (_label, modelName, supportsContextCompaction) => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_no_compaction', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, modelName, undefined, supportsContextCompaction);
  await model.getResponse({
    input: [],
    tools: [],
    providerOptions: { contextCompaction: { enabled: true, threshold: 0.5 } },
  });

  expect(capturedBody).not.toHaveProperty('context_management');
});

it('does not let extraBody bypass the HTTP context-compaction gate', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_no_compaction', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.6-luna', undefined, false);
  await model.getResponse({
    input: [],
    tools: [],
    providerOptions: {
      contextCompaction: { enabled: true, threshold: 0.5 },
      extraBody: { context_management: [{ type: 'compaction', compact_threshold: 1000 }] },
    },
  });

  expect(capturedBody).not.toHaveProperty('context_management');
});

it('getResponse (HTTP) translates generic message content into input_text/output_text by role', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_1', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await model.getResponse({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
    ],
    tools: [],
  });

  expect(capturedBody.input).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello there' }] },
  ]);
});

it('getResponse (HTTP) translates tool_call and function_call_result items into function_call/function_call_output', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_1', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await model.getResponse({
    input: [
      { type: 'tool_call', id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
      { type: 'tool_result', id: 'call_1', output: 'file1\nfile2' },
    ],
    tools: [],
  });

  expect(capturedBody.input).toEqual([
    { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'file1\nfile2' },
  ]);
});

it('stream (websocket) preserves typed settings, including zero values, in response.create', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'message', message: { type: 'response.completed', response: { id: 'resp_ws_settings' } } };
  };
  const model = new OpenAIResponsesWSModelWithPromptCacheKey(
    { responses: { create: async () => ({}) } },
    'gpt-5.4-nano',
  );
  await collect(
    model.stream({
      input: [],
      tools: [],
      toolChoice: { name: 'shell' },
      topP: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxTokens: 0,
    }),
  );

  expect(capturedWSRequest).toMatchObject({
    type: 'response.create',
    tool_choice: { type: 'function', name: 'shell' },
    top_p: 0,
    frequency_penalty: 0,
    presence_penalty: 0,
    max_output_tokens: 0,
  });
});

it('clamps a zero context compaction ratio to the API minimum', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_compaction_minimum', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.6-luna', undefined, true);
  await model.getResponse({
    input: [],
    tools: [],
    providerOptions: { contextCompaction: { enabled: true, threshold: 0 } },
  });

  expect(capturedBody.context_management).toEqual([{ type: 'compaction', compact_threshold: 1000 }]);
});

it('stream (websocket) sends context management only for an enabled supported OpenAI model', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'message', message: { type: 'response.completed', response: { id: 'resp_ws_compaction' } } };
  };
  const model = new OpenAIResponsesWSModelWithPromptCacheKey(
    { responses: { create: async () => ({}) } },
    'gpt-5.6-luna',
    undefined,
    true,
  );
  await collect(
    model.stream({
      input: [],
      tools: [],
      providerOptions: { contextCompaction: { enabled: true, threshold: 0.5 } },
    }),
  );

  expect(capturedWSRequest.context_management).toEqual([{ type: 'compaction', compact_threshold: 136_000 }]);
});

it('does not let extraBody bypass the WebSocket context-compaction gate', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'message', message: { type: 'response.completed', response: { id: 'resp_ws_no_compaction' } } };
  };
  const model = new OpenAIResponsesWSModelWithPromptCacheKey(
    { responses: { create: async () => ({}) } },
    'gpt-5.6-luna',
    undefined,
    false,
  );
  await collect(
    model.stream({
      input: [],
      tools: [],
      providerOptions: {
        contextCompaction: { enabled: true, threshold: 0.5 },
        extraBody: { context_management: [{ type: 'compaction', compact_threshold: 1000 }] },
      },
    }),
  );

  expect(capturedWSRequest).not.toHaveProperty('context_management');
});

it('emits direct typed completion output and usage without compatibility envelopes', async () => {
  const model = new OpenAIResponsesModelWithPromptCacheKey(
    {
      responses: {
        create: async () =>
          (async function* () {
            yield { type: 'response.output_text.delta', delta: 'answer' };
            yield {
              type: 'response.completed',
              response: {
                id: 'resp-direct',
                output: [
                  { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
                  { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
                  {
                    type: 'reasoning',
                    id: 'reason-1',
                    summary: [{ type: 'summary_text', text: 'brief thought' }],
                    encrypted_content: 'ciphertext',
                  },
                ],
                usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } },
              },
            };
          })(),
      },
    },
    'gpt-test',
  );
  await expect(collect(model.stream({ input: [], tools: [] }))).resolves.toEqual([
    { type: 'text_delta', text: 'answer' },
    {
      type: 'completion',
      responseId: 'resp-direct',
      output: [
        { type: 'message', content: [{ type: 'text', text: 'answer' }] },
        { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
        {
          type: 'reasoning',
          id: 'reason-1',
          text: 'brief thought',
          providerMetadata: { openai: { encrypted_content: 'ciphertext' } },
        },
      ],
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 },
    },
  ]);
});

it('turns an unknown Responses output item into provider_opaque instead of throwing', async () => {
  const model = new OpenAIResponsesModelWithPromptCacheKey(
    {
      responses: {
        create: async () =>
          (async function* () {
            yield {
              type: 'response.completed',
              response: {
                id: 'resp-compact',
                output: [
                  { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-blob' },
                  { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
                ],
                usage: {},
              },
            };
          })(),
      },
    },
    'gpt-5.4',
  );
  await expect(collect(model.stream({ input: [], tools: [] }))).resolves.toEqual([
    {
      type: 'completion',
      responseId: 'resp-compact',
      output: [
        {
          type: 'provider_opaque',
          provider: 'openai',
          item: { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-blob' },
        },
        { type: 'message', content: [{ type: 'text', text: 'answer' }] },
      ],
      usage: {},
    },
  ]);
});

it('splices an openai provider_opaque input item verbatim into the request', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_1', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await model.getResponse({
    input: [
      {
        type: 'provider_opaque',
        provider: 'openai',
        item: { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-blob' },
      },
    ],
    tools: [],
  });

  expect(capturedBody.input).toEqual([{ type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-blob' }]);
});

// A foreign opaque item is what a provider switch leaves behind. Throwing on it
// used to kill every later turn too, because nothing removes the item from
// history — so the conversation became unusable rather than merely lossy.
it('drops a non-openai provider_opaque item and still replays the rest of the history', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_1', output: [], usage: {} };
      },
    },
  };
  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.4-nano');

  await model.getResponse({
    input: [
      { type: 'provider_opaque', provider: 'codex', item: { type: 'compaction', encrypted_content: 'foreign-blob' } },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'still here' }] },
    ],
    tools: [],
  });

  expect(JSON.stringify(capturedBody.input)).not.toContain('foreign-blob');
  expect(capturedBody.input).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'still here' }] },
  ]);
});

it('replays native reasoning with encrypted_content and never emits provider_data', async () => {
  let capturedBody: any;
  const model = new OpenAIResponsesModelWithPromptCacheKey(
    {
      responses: {
        create: async (body: any) => {
          capturedBody = body;
          return { id: 'resp-replay', output: [] };
        },
      },
    },
    'gpt-test',
  );
  await model.getResponse({
    input: [
      {
        type: 'reasoning',
        id: 'reason-replay',
        text: 'brief thought',
        providerMetadata: { openai: { encrypted_content: 'ciphertext' } },
      },
    ],
    tools: [],
    providerOptions: {
      include: ['message.output_text'],
      extraBody: { include: ['reasoning.encrypted_content', 'file_search_call.results'] },
    },
  });

  expect(capturedBody.input).toEqual([
    {
      type: 'reasoning',
      id: 'reason-replay',
      summary: [{ type: 'summary_text', text: 'brief thought' }],
      encrypted_content: 'ciphertext',
    },
  ]);
  expect(capturedBody.include).toEqual([
    'reasoning.encrypted_content',
    'file_search_call.results',
    'message.output_text',
  ]);
  expect(capturedBody.input[0]).not.toHaveProperty('provider_data');
});

it('always projects encrypted reasoning include on the shared WebSocket request path', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'message', message: { type: 'response.completed', response: { id: 'resp-ws-reasoning' } } };
  };
  const model = new OpenAIResponsesWSModelWithPromptCacheKey({}, 'gpt-test');
  await collect(
    model.stream({
      input: [
        {
          type: 'reasoning',
          text: 'brief thought',
          providerMetadata: { openai: { encrypted_content: 'ciphertext' } },
        },
      ],
      tools: [],
      providerOptions: { include: ['message.output_text', 'reasoning.encrypted_content'] },
    }),
  );

  expect(capturedWSRequest.include).toEqual(['message.output_text', 'reasoning.encrypted_content']);
});

it('includes encrypted reasoning on a first WebSocket request without reasoning input', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'message', message: { type: 'response.completed', response: { id: 'resp-ws-first' } } };
  };
  const model = new OpenAIResponsesWSModelWithPromptCacheKey({}, 'gpt-test');

  await collect(model.stream({ input: [], tools: [] }));

  expect(capturedWSRequest.include).toEqual(['reasoning.encrypted_content']);
});

it.each([
  ['failed', { message: 'quota' }],
  ['incomplete', undefined],
] as const)('rejects unary %s responses before lifecycle terminal success', async (status, error) => {
  const observations: any[] = [];
  const model = new OpenAIResponsesModelWithPromptCacheKey(
    {
      responses: {
        create: async () => ({ id: `resp-${status}`, status, ...(error ? { error } : {}) }),
      },
    },
    'gpt-test',
    { record: () => {}, observe: (observation) => observations.push(observation) },
  );

  await expect(model.getResponse({ input: [], tools: [] })).rejects.toThrow(`response.${status}`);
  expect(observations.map((observation) => observation.phase)).toEqual(['request-built', 'failed']);
  expect(observations.find((observation) => observation.phase === 'terminal')).toBeUndefined();
});

it('fails when an HTTP stream ends without a terminal completion', async () => {
  const model = new OpenAIResponsesModelWithPromptCacheKey(
    { responses: { create: async () => (async function* () {})() } },
    'gpt-test',
  );
  await expect(collect(model.stream({ input: [], tools: [] }))).rejects.toThrow('ended without a completion');
});

it('binds lifecycle observations to the exact application request on HTTP and WebSocket', async () => {
  const binding = { snapshotIdentity: 'snapshot', snapshotRevision: 4, lineage: 2 };
  const request = { input: [], tools: [] } as const;
  for (const transport of ['http', 'websocket'] as const) {
    const observations: any[] = [];
    if (transport === 'websocket') {
      fakeResponsesWSStream = async function* () {
        yield { type: 'message', message: { type: 'response.completed', response: { id: 'resp-ws' } } };
      };
    }
    const client =
      transport === 'http'
        ? {
            responses: {
              create: async () =>
                (async function* () {
                  yield { type: 'response.completed', response: { id: 'resp-http', output: [] } };
                })(),
            },
          }
        : {};
    const model =
      transport === 'http'
        ? new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-test', {
            record: () => {},
            observe: (item) => observations.push(item),
          })
        : new OpenAIResponsesWSModelWithPromptCacheKey(client, 'gpt-test', {
            record: () => {},
            observe: (item) => observations.push(item),
          });
    await runWithOpenAIRequestPrefixBindingScope(async () => {
      prepareOpenAIRequestPrefixBinding(binding, request.input);
      await collect(model.stream(request));
    });
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ phase: 'request-built', prefixBinding: binding });
    expect(observations[1]).toMatchObject({ phase: 'terminal', prefixBinding: binding });
    expect(observations[0].token).toBe(observations[1].token);
  }
});

it('stream (websocket) throws on an error frame instead of silently ending the stream', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'error', error: new Error('upstream rejected the request') };
  };
  const client = { responses: { create: async () => ({}) } };

  const model = new OpenAIResponsesWSModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await expect(collect(model.stream({ input: [], tools: [] }))).rejects.toThrow('upstream rejected the request');
});

it('stream (websocket) throws on a close frame instead of silently ending the stream', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'close' };
  };
  const client = { responses: { create: async () => ({}) } };

  const model = new OpenAIResponsesWSModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await expect(collect(model.stream({ input: [], tools: [] }))).rejects.toThrow(
    'closed before a terminal response event',
  );
});

it('stops consuming the websocket after a terminal response event', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'message', message: { type: 'response.completed', response: { id: 'resp_1' } } };
    await new Promise<void>(() => {});
  };
  const client = { responses: { create: async () => ({}) } };
  const model = new OpenAIResponsesWSModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  const result = await Promise.race([
    collect(model.stream({ input: [], tools: [] })),
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);

  expect(result).not.toBe('timed-out');
});

it('reuses the persistent websocket across sequential completed streams and closes on close()', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'message', message: { type: 'response.completed', response: { id: 'resp_1' } } };
  };
  const client = { responses: { create: async () => ({}) } };
  const model = new OpenAIResponsesWSModelWithPromptCacheKey(client, 'gpt-5.4-nano');

  const events1 = await collect(model.stream({ input: [], tools: [] }));
  expect(events1).toHaveLength(1);

  const events2 = await collect(model.stream({ input: [], tools: [] }));
  expect(events2).toHaveLength(1);

  await model.close();
});
