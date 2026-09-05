import { it, expect, vi } from 'vitest';
const withTrace = async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
import {
  CodexResponsesTransport,
  OpenAIResponsesModel,
  CodexResponsesModel,
  CodexResponsesWSModel,
} from './codex-responses-model.js';
import type { IProviderTraffic } from '../services/service-interfaces.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import { wrapCodexStream } from './codex-responses-model.js';
import { RetryingModel } from './retrying-model.js';
import { AmbiguousModelOutcomeError } from '../services/retry/retry-errors.js';
import { recordWebSocketDispatch, UnsentWebSocketRequestError } from './websocket-request-dispatch.js';
// Fixture mirrors the SSE shape that codex's responses endpoint emits: deltas
// and output_item.done carry the assistant message, but the terminal
// response.completed frame ships an empty `output` array. The wrapper has to
// reconstruct the final output from the accumulated output_item.done items so
// the agents-SDK runner does not see "no output" and re-loop.
function makeStream(events: any[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

it('settles a terminal response when its retained transport iterator never closes', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-test', true);
  transport.fetchResponse = async () => {
    let emittedCompletion = false;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (!emittedCompletion) {
              emittedCompletion = true;
              return {
                done: false,
                value: { type: 'response.completed', response: { id: 'response-terminal', output: [] } },
              };
            }
            return new Promise<IteratorResult<any>>(() => undefined);
          },
          return: () => new Promise<IteratorResult<any>>(() => undefined),
        };
      },
    };
  };
  const model = new OpenAIResponsesModel({} as any, 'gpt-test', transport);

  const result = await Promise.race([
    collect(model.stream({ input: [], tools: [] })).then(() => 'settled' as const),
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);

  expect(result).toBe('settled');
});

it('uses isolated injected Codex transports without changing model prototypes', async () => {
  const baseFetch = Object.getOwnPropertyDescriptor(OpenAIResponsesModel.prototype, 'fetchResponse')?.value;
  const firstTransport = new CodexResponsesTransport();
  const secondTransport = new CodexResponsesTransport();
  firstTransport.fetchResponse = async () =>
    makeStream([{ type: 'response.completed', response: { id: 'response-first', output: [], usage: {} } }]);
  secondTransport.fetchResponse = async () =>
    makeStream([{ type: 'response.completed', response: { id: 'response-second', output: [], usage: {} } }]);

  const first = new CodexResponsesModel({} as any, 'gpt-test', undefined, undefined, firstTransport);
  const second = new CodexResponsesModel({} as any, 'gpt-test', undefined, undefined, secondTransport);
  const request = { input: [], tools: [] };

  const firstEvents = await collect(first.stream(request));
  const secondEvents = await collect(second.stream(request));

  expect(firstEvents.find((event: any) => event.type === 'completion')).toMatchObject({ responseId: 'response-first' });
  expect(secondEvents.find((event: any) => event.type === 'completion')).toMatchObject({
    responseId: 'response-second',
  });
  expect(Object.getOwnPropertyDescriptor(OpenAIResponsesModel.prototype, 'fetchResponse')?.value).toBe(baseFetch);
});

it('wrapCodexStream reconstructs response.completed.output from streamed output_item.done items', async () => {
  const item = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Hello!' }],
  };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: '!' },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          },
        },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed).toBeTruthy();
  expect(completed.response.output.length).toBe(1);
  expect(completed.response.output[0]).toBe(item);
});

it('wrapCodexStream reconstructs missing terminal response.output from streamed output_item.done items', async () => {
  const item = {
    type: 'message',
    id: 'msg_missing_output',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Recovered' }],
  };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'resp_missing_output',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed).toBeTruthy();
  expect(completed.response.output).toEqual([item]);
});

it('wrapCodexStream reconstructs missing output for non-completed terminal frames', async () => {
  const item = {
    type: 'message',
    id: 'msg_incomplete',
    role: 'assistant',
    status: 'incomplete',
    content: [{ type: 'output_text', text: 'Partial' }],
  };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.incomplete',
          response: {
            id: 'resp_incomplete',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    ),
  );

  const incomplete = events.find((e: any) => e.type === 'response.incomplete') as any;
  expect(incomplete).toBeTruthy();
  expect(incomplete.response.output).toEqual([item]);
});

it('wrapCodexStream leaves non-empty output untouched', async () => {
  const serverItem = { type: 'message', id: 'msg_real' };
  const streamedItem = { type: 'message', id: 'msg_accum' };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.output_item.done', output_index: 0, item: streamedItem },
        {
          type: 'response.completed',
          response: { id: 'resp_2', output: [serverItem], usage: {} },
        },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed.response.output.length).toBe(1);
  expect(completed.response.output[0]).toBe(serverItem);
});

it('wrapCodexStream reconstructs each completed response from only its own streamed items', async () => {
  const firstItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1' };
  const secondItem = { type: 'message', id: 'msg_2', role: 'assistant' };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_item.done', output_index: 0, item: firstItem },
        { type: 'response.completed', response: { id: 'resp_1', output: [], usage: {} } },
        { type: 'response.created', response: { id: 'resp_2' } },
        { type: 'response.output_item.done', output_index: 0, item: secondItem },
        { type: 'response.completed', response: { id: 'resp_2', output: [], usage: {} } },
      ]),
    ),
  );

  const completed = events.filter((e: any) => e.type === 'response.completed') as any[];
  expect(completed.length).toBe(2);
  expect(completed[0].response.output).toEqual([firstItem]);
  expect(completed[1].response.output).toEqual([secondItem]);
});

it('wrapCodexStream keeps empty output empty when no items were streamed', async () => {
  const events = await collect(
    wrapCodexStream(
      makeStream([
        {
          type: 'response.completed',
          response: { id: 'resp_3', output: [], usage: {} },
        },
      ]),
    ),
  );
  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed.response.output.length).toBe(0);
});

it('wrapCodexStream backfills function_call call_id from function_call_arguments.done event', async () => {
  const expectedCallId = 'call_backfilled';

  // Simulate Codex sending function_call_arguments.done with the call_id
  // followed by output_item.done WITHOUT a call_id field.
  const item = {
    type: 'function_call',
    id: 'fc_backfill',
    name: 'shell',
    arguments: '{}',
    status: 'completed',
    // NO call_id — Codex sometimes omits it here
  };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_backfill',
          call_id: expectedCallId,
          name: 'shell',
          arguments: '{}',
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'resp_backfill',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed).toBeTruthy();
  expect(completed.response.output.length).toBe(1);
  expect(completed.response.output[0].call_id).toBe(expectedCallId);
  expect(completed.response.output[0].id).toBe('fc_backfill');
});

it('wrapCodexStream survives a frozen response object by cloning', async () => {
  const item = { type: 'message', id: 'msg_frozen' };
  const frozenResponse = Object.freeze({ id: 'resp_f', output: [], usage: {} });

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: frozenResponse },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed.response.output.length).toBe(1);
  expect(completed.response.output[0]).toBe(item);
});

it('wrapCodexStream warns with metadata when reconstructed output is suspiciously large', async () => {
  const warnings: any[] = [];
  const items = Array.from({ length: 21 }, (_, index) => ({
    type: index % 2 === 0 ? 'function_call' : 'function_call_output',
    id: `item_${index}`,
    call_id: `call_${Math.floor(index / 2)}`,
    output: `hidden-output-${index}`,
  }));

  const events = await collect(
    wrapCodexStream(
      makeStream([
        ...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
        { type: 'response.completed', response: { id: 'resp_large', output: [], usage: {} } },
      ]),
      { warn: (_message: string, meta?: any) => warnings.push(meta) },
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed.response.output.length).toBe(21);
  expect(warnings.length).toBe(1);
  expect(warnings[0].eventType).toBe('codex.reconstructed_output.suspicious');
  expect(warnings[0].responseId).toBe('resp_large');
  expect(warnings[0].itemCount).toBe(21);
  expect(warnings[0].firstItemId).toBe('item_0');
  expect(warnings[0].lastItemId).toBe('item_20');
  expect('output' in warnings[0]).toBe(false);
});

// Integration check: confirm CodexResponsesModel.stream threads
// the stream through wrapCodexStream so a Codex-style terminal frame with
// empty output gets rebuilt into a populated completion event. The owned
// transport dependency supplies a controlled stream without a real client.
it('CodexResponsesModel.stream carries output_tokens_details.reasoning_tokens into completion usage', async () => {
  const reasoningTransport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  reasoningTransport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_reasoning' } },
      {
        type: 'response.completed',
        response: {
          id: 'resp_reasoning',
          output: [],
          usage: {
            input_tokens: 90,
            output_tokens: 54,
            output_tokens_details: { reasoning_tokens: 52 },
          },
        },
      },
    ]);
  };

  const reasoningModel = new CodexResponsesModel({} as any, 'gpt-5-codex', reasoningTransport);
  const reasoningEvents = await collect(reasoningModel.stream({ input: [], tools: [] } as any));

  const reasoningDone = reasoningEvents.find((e: any) => e.type === 'completion') as any;
  expect(reasoningDone).toBeTruthy();
  expect(reasoningDone.usage).toMatchObject({ inputTokens: 90, outputTokens: 54, reasoningTokens: 52 });
});

it('CodexResponsesModel.stream yields completion with reconstructed output', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_1' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello!' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      },
    ]);
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const request: any = { input: [], tools: [] };
    const events = await collect(model.stream(request));

    const done = events.find((e: any) => e.type === 'completion') as any;
    expect(done).toBeTruthy();
    expect(done.output.length).toBe(1);
    expect(done.output[0].type).toBe('message');
  } finally {
  }
});

it('CodexResponsesModel.stream tolerates missing terminal response.output', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_missing_output' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_missing_output',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Recovered' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_missing_output',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]);
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const request: any = { input: [], tools: [] };
    const events = await collect(model.stream(request));

    const done = events.find((e: any) => e.type === 'completion') as any;
    expect(done).toBeTruthy();
    expect(done.output.length).toBe(1);
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest merges Codex include into requestData.include', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        include: ['file_search_call.results'],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest(
      {
        input: [],
        tools: [],
        codex: { include: ['reasoning.encrypted_content', 'file_search_call.results'] },
      },
      true,
    );

    expect(built.requestData.include).toEqual(['file_search_call.results', 'reasoning.encrypted_content']);
  } finally {
  }
});

it('CodexResponsesTransport never sends context_management on create', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5.6-sol', false, {
    supportsContextCompaction: true,
  });
  const built = transport.buildResponsesCreateRequest(
    {
      input: [],
      tools: [],
      providerOptions: { contextCompaction: { enabled: true, threshold: 0.5 } },
    },
    true,
  );

  expect(built.requestData).not.toHaveProperty('context_management');
  expect(built.requestData).not.toHaveProperty('contextCompaction');
});

it('CodexResponsesTransport.compactHistory uses the Responses compaction trigger and marks the opaque item', async () => {
  const create = vi.fn(async (body: any) => {
    expect(body).toEqual({
      model: 'gpt-5.6-luna',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'compaction_trigger' },
      ],
      parallel_tool_calls: true,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { context: 'all_turns' },
    });
    return (async function* () {
      yield {
        type: 'response.output_item.done',
        item: { type: 'compaction', id: 'cmp_1', encrypted_content: 'cipher' },
      };
      yield { type: 'response.completed', response: { id: 'resp_1' } };
    })();
  });
  const transport = new CodexResponsesTransport({ responses: { create } } as any, 'gpt-5.6-luna', false);
  const result = await transport.compactHistory({
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(result.history).toEqual([
    {
      type: 'compaction',
      id: 'cmp_1',
      encrypted_content: 'cipher',
      providerOpaque: { provider: 'openai' },
    },
  ]);
});

it('CodexResponsesTransport does not send context_management for Responses-Lite models', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5.6-luna', false, {
    supportsContextCompaction: true,
  });
  const built = transport.buildResponsesCreateRequest(
    {
      input: [],
      tools: [],
      providerOptions: { contextCompaction: { enabled: true, threshold: 0.5 } },
    },
    true,
  );

  expect(built.requestData).not.toHaveProperty('context_management');
});

it('CodexResponsesTransport does not send context_management without provider capability', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5.3-codex-spark', false);
  const built = transport.buildResponsesCreateRequest(
    {
      input: [],
      tools: [],
      providerOptions: { contextCompaction: { enabled: true, threshold: 0.5 } },
    },
    true,
  );

  expect(built.requestData).not.toHaveProperty('context_management');
  expect(built.requestData).not.toHaveProperty('contextCompaction');
});

it('CodexResponsesTransport does not let extraBody bypass the context-compaction gate', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5.3-codex-spark', false, {
    supportsContextCompaction: true,
  });
  const built = transport.buildResponsesCreateRequest(
    {
      input: [],
      tools: [],
      providerOptions: {
        extraBody: { context_management: [{ type: 'compaction', compact_threshold: 1000 }] },
      },
    },
    true,
  );

  expect(built.requestData).not.toHaveProperty('context_management');
});

it('CodexResponsesTransport disables context_management after a session-level compaction failure', () => {
  const sessionState = { disabled: true };
  const transport = new CodexResponsesTransport({} as any, 'gpt-5.3-codex-spark', false, {
    supportsContextCompaction: true,
    contextCompactionSessionState: sessionState,
  });
  const built = transport.buildResponsesCreateRequest(
    {
      input: [],
      tools: [],
      providerOptions: { contextCompaction: { enabled: true, threshold: 0.5 } },
    },
    true,
  );

  expect(built.requestData).not.toHaveProperty('context_management');
});

it('CodexResponsesTransport marks opaque context_management 500s as session-disabling failures', async () => {
  const sessionState = { disabled: false };
  const error = Object.assign(new Error('server_error'), {
    status: 500,
    error: { message: 'context_management failed with server_error' },
  });
  const client = {
    responses: {
      create: async () => {
        throw error;
      },
    },
  };
  const transport = new CodexResponsesTransport(client as any, 'gpt-5.3-codex-spark', false, {
    supportsContextCompaction: true,
    contextCompactionSessionState: sessionState,
  });

  await expect(
    transport.fetchResponse(
      {
        input: [],
        tools: [],
        providerOptions: { contextCompaction: { enabled: true, threshold: 0.5 } },
      },
      false,
      { model: 'gpt-5.3-codex-spark' },
    ),
  ).rejects.toBe(error);

  expect(sessionState.disabled).toBe(true);
  expect((error as any).contextCompactionFailure).toBe('request');
});

it('does not attribute a generic server_error 500 to context compaction without context-management evidence', async () => {
  const sessionState = { disabled: false };
  // `server_error` must appear in the *serialized* error, which is what the
  // classifier inspects. Error.message is non-enumerable, so putting the
  // marker only in `new Error('server_error')` leaves JSON.stringify output
  // without it and the test passes even on the pre-fix classifier. Carry it
  // in enumerable fields, the shape a real OpenAI 5xx has.
  const error = Object.assign(new Error('server_error'), {
    status: 500,
    error: { message: 'Model is at capacity', type: 'server_error', code: 'server_error' },
  });
  expect(JSON.stringify(error)).toMatch(/server_error/);
  expect(JSON.stringify(error)).not.toMatch(/context[_ ]management/i);
  const client = {
    responses: {
      create: async () => {
        throw error;
      },
    },
  };
  const transport = new CodexResponsesTransport(client as any, 'gpt-5.3-codex-spark', false, {
    supportsContextCompaction: true,
    contextCompactionSessionState: sessionState,
  });

  await expect(
    transport.fetchResponse(
      {
        input: [],
        tools: [],
        providerOptions: { contextCompaction: { enabled: true, threshold: 0.5 } },
      },
      false,
      { model: 'gpt-5.3-codex-spark' },
    ),
  ).rejects.toBe(error);

  // A transport failure must not be attributed to compaction, and must not
  // disable session compaction as a side effect.
  expect(sessionState.disabled).toBe(false);
  expect((error as any).contextCompactionFailure).toBeUndefined();
});

it('keeps a native Codex compaction item as provider_opaque instead of throwing', async () => {
  const transport = new CodexResponsesTransport();
  transport.fetchResponse = async () =>
    makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp_compact',
          output: [
            { type: 'compaction', id: 'cmp_1', encrypted_content: 'cipher' },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
          ],
        },
      },
    ]);
  const model = new CodexResponsesModel({} as any, 'gpt-5.6-sol', undefined, undefined, transport);
  const events = await collect(model.stream({ input: [], tools: [] }));
  const completion = events.find((event) => event.type === 'completion');
  expect(completion).toMatchObject({
    type: 'completion',
    responseId: 'resp_compact',
    output: [
      {
        type: 'provider_opaque',
        provider: 'openai',
        item: { type: 'compaction', id: 'cmp_1', encrypted_content: 'cipher' },
      },
      { type: 'message', content: [{ type: 'text', text: 'ok' }] },
    ],
  });
});

it('CodexResponsesTransport formats reasoning input items with required summary array for Responses API', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5.6-sol', false);
  const built = transport.buildResponsesCreateRequest(
    {
      input: [
        {
          type: 'reasoning',
          id: 'rs_1',
          text: 'thinking process',
          providerMetadata: { codex: { encrypted_content: 'cipher_a' } },
        },
        {
          type: 'reasoning',
          id: 'rs_2',
          text: '',
          providerMetadata: { codex: { encrypted_content: 'cipher_b' } },
        },
      ],
      tools: [],
    },
    true,
  );

  expect(built.requestData.input).toEqual([
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'thinking process' }],
      encrypted_content: 'cipher_a',
    },
    {
      type: 'reasoning',
      id: 'rs_2',
      summary: [],
      encrypted_content: 'cipher_b',
    },
  ]);
});

it('Codex HTTP writes every supported request setting and the abort signal to the Responses boundary', async () => {
  let capturedBody: any;
  let capturedOptions: any;
  const client = {
    responses: {
      create: async (body: any, options: any) => {
        capturedBody = body;
        capturedOptions = options;
        return makeStream([{ type: 'response.completed', response: { id: 'resp_settings', output: [], usage: {} } }]);
      },
    },
  };
  const controller = new AbortController();
  const model = new CodexResponsesModel(client as any, 'gpt-5.3-codex');
  await collect(
    model.stream({
      instructions: 'PROJECT_CONTEXT_SENTINEL',
      previousResponseId: 'resp_before',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
      signal: controller.signal,
      toolChoice: { name: 'lookup' },
      temperature: 0.2,
      topP: 0.8,
      frequencyPenalty: 0.3,
      presencePenalty: 0.4,
      maxTokens: 123,
      reasoning: { effort: 'high', summary: 'concise' },
      providerOptions: { generate: false, custom_codex_option: true, extraHeaders: { 'x-test': 'yes' } },
    }),
  );

  expect(capturedBody).toMatchObject({
    model: 'gpt-5.3-codex',
    stream: true,
    instructions: 'PROJECT_CONTEXT_SENTINEL',
    previous_response_id: 'resp_before',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'lookup' },
    top_p: 0.8,
    frequency_penalty: 0.3,
    presence_penalty: 0.4,
    reasoning: { effort: 'high', summary: 'concise' },
    generate: false,
    custom_codex_option: true,
  });
  expect(capturedBody.temperature).toBeUndefined();
  expect(capturedBody.max_output_tokens).toBeUndefined();
  expect(capturedOptions).toEqual({ signal: controller.signal, headers: { 'x-test': 'yes' } });
});

it('Codex Responses serializes custom grammar tools and custom tool calls', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return makeStream([
          {
            type: 'response.output_item.done',
            item: {
              type: 'custom_tool_call',
              call_id: 'call_patch',
              name: 'apply_patch',
              input: '*** Begin Patch\n*** End Patch',
            },
          },
          {
            type: 'response.completed',
            response: {
              id: 'resp_custom_patch',
              output: [
                {
                  type: 'custom_tool_call',
                  call_id: 'call_patch',
                  name: 'apply_patch',
                  input: '*** Begin Patch\n*** End Patch',
                },
              ],
              usage: {},
            },
          },
        ]);
      },
    },
  };
  const model = new CodexResponsesModel(client as any, 'gpt-5.3-codex');
  const events = await collect(
    model.stream({
      input: [],
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'freeform patch',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: patch' },
        },
      ],
    }),
  );

  expect(capturedBody.tools).toEqual([
    {
      type: 'custom',
      name: 'apply_patch',
      description: 'freeform patch',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: patch' },
    },
  ]);
  expect(events).toContainEqual({
    type: 'completion',
    responseId: 'resp_custom_patch',
    output: [
      {
        type: 'tool_call',
        id: 'call_patch',
        name: 'apply_patch',
        arguments: '*** Begin Patch\n*** End Patch',
        toolType: 'custom',
      },
    ],
  });
});

it('CodexResponsesModel.buildResponsesCreateRequest strips temperature and max_output_tokens from requestData', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        temperature: 0.2,
        max_output_tokens: 16384,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest(
      { input: [], tools: [], temperature: 0.2, maxTokens: 16384 },
      true,
    );

    expect('temperature' in built.requestData).toBe(false);
    expect('max_output_tokens' in built.requestData).toBe(false);
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest forwards the Codex prompt cache key', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        include: [],
        temperature: 0.4,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest(
      { input: [], tools: [], codex: { promptCacheKey: 'conv_123' } },
      true,
    );

    expect(built.requestData.prompt_cache_key).toBe('conv_123');
    expect('temperature' in built.requestData).toBe(false);
  } finally {
  }
});

it('Codex request capture records the exact normalized suffix projection without changing it', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const captures: any[] = [];
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        model: 'gpt-5-codex',
        previous_response_id: 'resp-1',
        input: [{ type: 'function_call_output', call_id: 'call-1', output: 'result' }],
        temperature: 0.2,
      },
    };
  };
  try {
    const model = new CodexResponsesModel(
      {} as any,
      'gpt-5-codex',
      undefined,
      {
        record: (projection) => captures.push(projection),
      },
      transport,
    );
    const built = (model as any).buildResponsesCreateRequest(
      { input: [], tools: [], codex: { promptCacheKey: 'cache-key' } },
      true,
    );

    expect(captures).toEqual([
      {
        provider: 'codex',
        transport: 'http',
        requestData: {
          model: 'gpt-5-codex',
          previous_response_id: 'resp-1',
          input: [{ type: 'function_call_output', call_id: 'call-1', output: 'result' }],
          prompt_cache_key: 'cache-key',
        },
      },
    ]);
    expect(built.requestData).toEqual(captures[0].requestData);
  } finally {
  }
});

it('CodexResponsesModel sends gpt-5.6-luna through the Responses Lite protocol', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        instructions: 'Follow the repository instructions.',
        input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: 'Review this change.' }] }],
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
        parallel_tool_calls: true,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5.6-luna', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.instructions).toBe('');
    expect(built.requestData.tools).toBeUndefined();
    expect(built.requestData.parallel_tool_calls).toBe(false);
    expect(built.requestData.reasoning).toMatchObject({ context: 'all_turns' });
    expect(built.requestData.client_metadata).toEqual({ 'x-openai-internal-codex-responses-lite': 'true' });
    expect(built.requestData.input).toEqual([
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      },
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Follow the repository instructions.' }],
      },
      { role: 'user', type: 'message', content: [{ type: 'text', text: 'Review this change.' }] },
    ]);
  } finally {
  }
});

it('CodexResponsesModel does not resend Luna developer instructions on chained requests', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        previous_response_id: 'resp_previous',
        instructions: 'Follow the repository instructions.',
        input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: 'Continue the review.' }] }],
        tools: [],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5.6-luna', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.input).toEqual([
      { type: 'additional_tools', role: 'developer', tools: [] },
      { role: 'user', type: 'message', content: [{ type: 'text', text: 'Continue the review.' }] },
    ]);
    expect(built.requestData.instructions).toBe('');
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest strips replay item ids from input', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        input: [
          { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
          { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc' },
          { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
          { id: 'ig_1', type: 'image_generation_call', status: 'completed', result: 'image' },
        ],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect('id' in built.requestData.input[0]).toBe(false);
    expect('id' in built.requestData.input[1]).toBe(false);
    expect('id' in built.requestData.input[2]).toBe(false);
    expect(built.requestData.input[2].call_id).toBe('call_1');
    expect('id' in built.requestData.input[3]).toBe(false);
    expect(built.requestData.input[4].id).toBe('ig_1');
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest drops the camelCase callId key after adding call_id', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  // codex.provider.ts's codexStream() builds tool_call/tool_result items as
  // `{ type: 'function_call', id: ... }` / `{ type: 'function_call_output', id: ... }`
  // (camelCase, no call_id) — the real shape a tool-call continuation sends.
  // The Responses API rejects unknown parameters, so leaving `callId` on the
  // object alongside the added `call_id` breaks every tool-call continuation.
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        input: [
          { type: 'function_call', callId: 'call_1', name: 'shell', arguments: '{}' },
          { type: 'function_call_output', callId: 'call_1', output: 'ok' },
        ],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.input[0]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'shell',
      arguments: '{}',
    });
    expect(built.requestData.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'ok',
    });
    expect('callId' in built.requestData.input[0]).toBe(false);
    expect('callId' in built.requestData.input[1]).toBe(false);
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest drops unpaired function calls for stateless fallback', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        input: [
          { role: 'user', type: 'message', content: [{ type: 'text', text: 'continue' }] },
          { id: 'fc_1', type: 'function_call', call_id: 'call-paired', name: 'shell', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-paired', output: 'ok' },
          { id: 'fc_2', type: 'function_call', call_id: 'call-orphan', name: 'shell', arguments: '{}' },
        ],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.previous_response_id).toBeUndefined();
    expect(built.requestData.input.map((item: any) => item.call_id).filter(Boolean)).toEqual([
      'call-paired',
      'call-paired',
    ]);
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest keeps function calls for chained requests', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        previous_response_id: 'resp_123',
        input: [{ id: 'fc_1', type: 'function_call', call_id: 'call-server-held', name: 'shell', arguments: '{}' }],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.input).toEqual([
      { type: 'function_call', call_id: 'call-server-held', name: 'shell', arguments: '{}' },
    ]);
  } finally {
  }
});

it('CodexResponsesWSModel emits traffic logs for websocket streamed responses', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordResponseClosed() {},
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_traffic' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_ws_traffic',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello WS traffic!' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_ws_traffic',
          output: [],
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        },
      },
    ]);
  };

  const sessionContextService = {
    getContext: () => ({
      sessionId: 'sess_ws_1',
      sessionStartedAt: '2025-01-01T00:00:00.000Z',
      mode: 'websocket',
      traceId: 'trace-session-1',
    }),
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      mockProviderTraffic as any,
      sessionContextService as any,
      transport,
    );
    const request: any = { input: [], tools: [] };

    const events = await collect(model.stream(request));

    expect((events[events.length - 1] as any).type).toBe('completion');
    expect(trafficCalls.length).toBe(2);
    expect(trafficCalls[0].method).toBe('recordRequestStart');
    expect(trafficCalls[1].method).toBe('recordResponseReceived');
    expect(trafficCalls[0].args.requestId).toBe(trafficCalls[1].args.requestId);
    expect(trafficCalls[0].args.sessionId).toBeUndefined(); // Codex model doesn't pass sessionId directly
    expect(trafficCalls[0].args.headers.authorization).toBe('[REDACTED]');
    expect(trafficCalls[1].args.transport).toBe('websocket');
  } finally {
  }
});

it('CodexResponsesWSModel records a metadata-only outcome when a consumer closes a live stream', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
    recordResponseClosed(input: any) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_closed' } },
      { type: 'response.output_text.delta', delta: 'partial output must not be logged' },
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    transport,
  );
  const iterator = model.stream({ input: [], tools: [] })[Symbol.asyncIterator]();

  expect(await iterator.next()).toMatchObject({
    value: { type: 'text_delta', text: 'partial output must not be logged' },
  });
  await iterator.return?.();

  expect(trafficCalls.map(({ method }) => method)).toEqual(['recordRequestStart', 'recordResponseClosed']);
  expect(trafficCalls[1].args).toMatchObject({ outcome: 'consumer_closed', eventCount: 2 });
  expect(JSON.stringify(trafficCalls[1].args)).not.toContain('partial output must not be logged');
});

// Regression for the observability gap: a WebSocket that ends abnormally
// (e.g. close code 1006) previously landed in the same 'consumer_closed'
// bucket as a deliberate stop, with no diagnostics attached at all — a failed
// artifact with thousands of frames retained no category/counter/timing
// evidence of what the model was doing when the socket dropped.
it('CodexResponsesWSModel records an abnormal WebSocket close as a failed outcome with bounded progress evidence', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
    recordResponseClosed(input: any) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_close_1006' } },
      { type: 'response.output_text.delta', delta: 'sensitive in-flight text' },
      { type: 'response.reasoning_summary_text.delta', delta: 'sensitive reasoning' },
      { type: 'response.output_item.added', output_item: { type: 'function_call', name: 'apply_patch' } },
      { type: 'response.function_call_arguments.delta', delta: 'sensitive patch arguments' },
      { type: 'close', code: 1006, reason: 'abnormal closure' },
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    transport,
  );

  await expect(collect(model.stream({ input: [], tools: [] }))).rejects.toThrow();

  const closed = trafficCalls.find(({ method }) => method === 'recordResponseClosed');
  expect(closed).toBeDefined();
  expect(closed!.args).toMatchObject({ outcome: 'failed', eventCount: 6 });

  const diagnostics = closed!.args.diagnostics;
  // Mechanically bounded: fixed category/counter/timing fields survive, but
  // the raw transcript, the raw-type breakdown, and the free-text close
  // reason do not — those are the unbounded/provider-authored surfaces.
  expect(diagnostics).not.toHaveProperty('events');
  expect(diagnostics).not.toHaveProperty('eventTypeCounts');
  expect(diagnostics).not.toHaveProperty('closeReason');
  expect(diagnostics.closeCode).toBe(1006);
  expect(diagnostics.eventCount).toBe(6);
  expect(diagnostics.progressCategoryCounts).toMatchObject({ text: 1, reasoning: 1 });
  expect(diagnostics).toMatchObject({
    toolArgumentDeltaFrames: 1,
    toolArgumentDeltaCharacters: 'sensitive patch arguments'.length,
    toolCallStartFrames: 1,
  });
  expect(typeof diagnostics.durationMs).toBe('number');
  // No sensitive payload content, and no close reason text, leaks through the
  // bounded summary.
  expect(JSON.stringify(diagnostics)).not.toContain('sensitive in-flight text');
  expect(JSON.stringify(diagnostics)).not.toContain('sensitive reasoning');
  expect(JSON.stringify(diagnostics)).not.toContain('sensitive patch arguments');
  expect(JSON.stringify(diagnostics)).not.toContain('abnormal closure');
});

it('CodexResponsesWSModel labels a consumer-closed stream as aborted when its request signal is aborted', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart() {},
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
    recordResponseClosed(input: any) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_aborted' } },
      { type: 'response.output_text.delta', delta: 'partial output' },
    ]);
  };

  const controller = new AbortController();
  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    transport,
  );
  const iterator = model.stream({ input: [], tools: [], signal: controller.signal })[Symbol.asyncIterator]();

  await iterator.next();
  controller.abort();
  await iterator.return?.();

  expect(trafficCalls).toEqual([
    expect.objectContaining({ method: 'recordResponseClosed', args: expect.objectContaining({ outcome: 'aborted' }) }),
  ]);
});

// An aborted stream leaves no payload behind, so the transcript is the only
// evidence of what the model was doing when the deadline cut it off.
it('CodexResponsesWSModel retains the partial transcript of an aborted stream', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart() {},
    async recordResponseReceived() {},
    recordRequestFailed() {},
    recordResponseClosed(input: any) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_runaway' } },
      { type: 'response.output_text.delta', delta: 'runaway output' },
    ]);
  };

  const controller = new AbortController();
  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    transport,
  );
  const iterator = model.stream({ input: [], tools: [], signal: controller.signal })[Symbol.asyncIterator]();

  await iterator.next();
  controller.abort();
  await iterator.return?.();

  const diagnostics = trafficCalls[0]!.args.diagnostics;
  expect(diagnostics.responseId).toBe('resp_ws_runaway');
  expect(diagnostics.eventTypeCounts).toMatchObject({ 'response.created': 1, 'response.output_text.delta': 1 });
  expect(JSON.stringify(diagnostics.events)).toContain('runaway output');
  expect(typeof diagnostics.durationMs).toBe('number');
});

it('CodexResponsesWSModel retains the partial transcript when an abort interrupts a pending frame', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart() {},
    async recordResponseReceived() {},
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
    recordResponseClosed(input: any) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
  };

  transport.fetchResponse = async function (request: any) {
    const events = [
      { type: 'response.created', response: { id: 'resp_ws_pending_abort' } },
      { type: 'response.output_item.added', output_item: { type: 'function_call', name: 'apply_patch' } },
      { type: 'response.function_call_arguments.delta', delta: '{"type":"update_file"}' },
    ];
    let index = 0;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (index < events.length) return Promise.resolve({ done: false, value: events[index++] });
          return new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          });
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };

  const controller = new AbortController();
  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    undefined,
    transport,
  );
  const iterator = model.stream({ input: [], tools: [], signal: controller.signal })[Symbol.asyncIterator]();

  await expect(iterator.next()).resolves.toMatchObject({
    value: { type: 'tool_call_streaming_delta', argumentCharCount: '{"type":"update_file"}'.length },
  });
  const pending = iterator.next();
  controller.abort();
  await expect(pending).rejects.toThrow();

  expect(trafficCalls.map(({ method }) => method)).toEqual(['recordResponseClosed']);
  const diagnostics = trafficCalls[0]!.args.diagnostics;
  expect(trafficCalls[0]!.args.outcome).toBe('aborted');
  expect(diagnostics.eventTypeCounts).toMatchObject({
    'response.created': 1,
    'response.output_item.added': 1,
    'response.function_call_arguments.delta': 1,
  });
  expect(diagnostics.toolArgumentDeltaFrames).toBe(1);
  expect(JSON.stringify(diagnostics.events)).toContain('update_file');
});

it('CodexResponsesWSModel keeps provider stream failures on the existing failure path', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordResponseClosed(input) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.failed', response: { status: 'failed', error: { message: 'provider failed' } } },
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    transport,
  );

  await expect(collect(model.stream({ input: [], tools: [] }))).rejects.toThrow('provider failed');
  expect(trafficCalls.map(({ method }) => method)).toEqual(['recordRequestStart', 'recordRequestFailed']);
});

it('CodexResponsesWSModel sends only new input after a Responses-Lite prefix is established', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficBodies: any[] = [];
  const captures: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  transport.fetchResponse = async function () {
    responseCount += 1;
    return makeStream([
      {
        type: 'response.completed',
        response: { id: `resp_lite_${responseCount}`, output: [], usage: {} },
      },
    ]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-lite-prefix', traceId: 'trace-lite-prefix' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      undefined,
      { record: (projection) => captures.push(projection) },
      transport,
    );

    const tool = { type: 'function', name: 'shell', parameters: { type: 'object' } };
    const firstUserMessage = { role: 'user', type: 'message', content: [{ type: 'text', text: 'hello' }] };
    const secondUserMessage = {
      role: 'user',
      type: 'message',
      content: [{ type: 'text', text: 'how are you?' }],
    };

    await collect(
      model.stream({
        input: [firstUserMessage],
        instructions: 'Follow the repository instructions.',
        tools: [tool],
      } as any),
    );
    await collect(
      model.stream({
        // The opening turn is one request now, so it is `resp_lite_1` that the
        // second turn chains onto.
        previousResponseId: 'resp_lite_1',
        input: [firstUserMessage, secondUserMessage],
        instructions: 'Follow the repository instructions.',
        tools: [tool],
      } as any),
    );

    // Turn 1 is a full Responses-Lite request. Turn 2 chains onto that response
    // and sends only the new user message.
    expect(trafficBodies).toHaveLength(2);
    expect(trafficBodies[0].input[0]).toMatchObject({ type: 'additional_tools', role: 'developer', tools: [tool] });
    expect(trafficBodies[0].previous_response_id).toBeUndefined();
    expect(trafficBodies[0].input.filter((item: any) => item?.type === 'message' && item?.role === 'user')).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    ]);
    expect(trafficBodies[1].previous_response_id).toBe('resp_lite_1');
    expect(trafficBodies[1].input).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'input_text', text: 'how are you?' }] }),
    ]);
    expect(captures.map((capture) => capture.requestData)).toEqual(trafficBodies);
    expect(captures.map((capture) => capture.transport)).toEqual(['websocket', 'websocket']);
  } finally {
  }
});

it('CodexResponsesWSModel chains Luna turns when the caller omits previousResponseId', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficBodies: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  transport.fetchResponse = async function () {
    responseCount += 1;
    return makeStream([
      {
        type: 'response.completed',
        response: { id: `resp_lite_${responseCount}`, output: [], usage: {} },
      },
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5.6-luna',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    {
      getContext: () => ({ sessionId: 'session-lite-omitted-prev', traceId: 'trace-lite-omitted-prev' } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    } as any,
    transport,
  );

  const tool = { type: 'function', name: 'read_file', parameters: { type: 'object' } };
  const firstUserMessage = { role: 'user', type: 'message', content: [{ type: 'text', text: 'hello' }] };
  const secondUserMessage = {
    role: 'user',
    type: 'message',
    content: [{ type: 'text', text: 'how are you?' }],
  };

  await collect(
    model.stream({
      input: [firstUserMessage],
      instructions: 'Follow the repository instructions.',
      tools: [tool],
    } as any),
  );
  await collect(
    model.stream({
      input: [firstUserMessage, secondUserMessage],
      instructions: 'Follow the repository instructions.',
      tools: [tool],
    } as any),
  );

  expect(trafficBodies).toHaveLength(2);
  expect(trafficBodies[0].previous_response_id).toBeUndefined();
  expect(trafficBodies[1].previous_response_id).toBe('resp_lite_1');
  expect(trafficBodies[1].input).toEqual([
    expect.objectContaining({ role: 'user', content: [{ type: 'input_text', text: 'how are you?' }] }),
  ]);
});

it('CodexResponsesWSModel does not replay a Luna tool transcript when server output differs from restored history', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficBodies: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  transport.fetchResponse = async function () {
    responseCount += 1;
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: `resp_lite_tool_${responseCount}`,
          output:
            responseCount === 1
              ? [
                  { type: 'reasoning', id: 'reasoning-server', encrypted_content: 'server-form', summary: [] },
                  { type: 'function_call', id: 'fc-server', call_id: 'call-1', name: 'shell', arguments: '{}' },
                ]
              : [],
          usage: {},
        },
      },
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5.6-luna',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    {
      getContext: () => ({ sessionId: 'session-lite-tool-delta', traceId: 'trace-lite-tool-delta' } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    } as any,
    transport,
  );

  const userMessage = { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect it' }] };
  await collect(model.stream({ input: [userMessage], tools: [] } as any));

  await collect(
    model.stream({
      previousResponseId: 'resp_lite_tool_1',
      input: [
        userMessage,
        { type: 'reasoning', encrypted_content: 'restored-form', summary: [] },
        { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{}' },
        { type: 'tool_result', id: 'call-1', output: 'done' },
      ],
      tools: [],
    } as any),
  );

  expect(trafficBodies).toHaveLength(2);
  expect(trafficBodies[1].previous_response_id).toBe('resp_lite_tool_1');
  expect(trafficBodies[1].input).toEqual([
    expect.objectContaining({ type: 'function_call_output', call_id: 'call-1', output: 'done' }),
  ]);
});

it('CodexResponsesWSModel correlates server-managed state across sequential streamed requests for standard models', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficBodies: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  transport.fetchResponse = async function () {
    responseCount += 1;
    return makeStream([
      {
        type: 'response.completed',
        response: { id: `resp_token_${responseCount}`, output: [], usage: {} },
      },
    ]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-token', traceId: 'trace-token' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    const tool = { type: 'function', name: 'shell', parameters: { type: 'object' } };
    const msg1 = { role: 'user', type: 'message', content: [{ type: 'text', text: 'first' }] };
    const msg2 = { role: 'user', type: 'message', content: [{ type: 'text', text: 'second' }] };

    // First turn establishes the stored baseline.
    await collect(
      model.stream({
        input: [msg1],
        instructions: 'Do it.',
        tools: [tool],
      } as any),
    );

    // Second turn chains off the first, which is `resp_token_1` now that the
    // opening turn is a single request.
    await collect(
      model.stream({
        previousResponseId: 'resp_token_1',
        input: [msg1, msg2],
        instructions: 'Do it.',
        tools: [tool],
      } as any),
    );

    // Traffic captures tell us the delta is correctly computed across turns.
    expect(trafficBodies).toHaveLength(2);
    // The second body (the second turn) should carry just the new user message
    // as a delta.
    expect(trafficBodies[1].previous_response_id).toBe('resp_token_1');
    expect(trafficBodies[1].input).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] }),
    ]);
  } finally {
  }
});

it('CodexResponsesWSModel does not use wire state for non-Luna models', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.fetchResponse = async function () {
    return makeStream([{ type: 'response.completed', response: { id: 'resp_nonluna', output: [], usage: {} } }]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-nonluna', traceId: 'trace-nonluna' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    // Verify no tokens are stored for non-Luna requests.
    const built = (model as any).buildResponsesCreateRequest(
      {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
      },
      true,
    );

    // requestTokens WeakMap should not have an entry for the request.
    // The built requestData should not have been modified by wire state prep.
    expect(built.requestData.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
  } finally {
  }
});

it('CodexResponsesWSModel marks Luna websocket requests as Responses Lite', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let seenRequest: any;
  transport.fetchResponse = async function (request: any) {
    seenRequest = request;
    return makeStream([{ type: 'response.completed', response: { id: 'resp_luna', output: [], usage: {} } }]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      transport,
    );

    await collect(model.stream({ input: [], tools: [] }));

    expect(seenRequest.providerOptions.extraHeaders['x-openai-internal-codex-responses-lite']).toBe('true');
    expect(seenRequest.providerOptions.client_metadata).toEqual({
      ws_request_header_x_openai_internal_codex_responses_lite: 'true',
    });
  } finally {
  }
});

it('CodexResponsesWSModel sends Codex turn identity metadata for Luna', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let seenRequest: any;
  transport.fetchResponse = async function (request: any) {
    seenRequest = request;
    return makeStream([{ type: 'response.completed', response: { id: 'resp_luna_identity', output: [], usage: {} } }]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      {
        getOrRefreshAccessToken: async () => 'token',
        getAccountId: () => 'acc_123',
        getInstallationId: () => 'installation-123',
      } as any,
      undefined,
      undefined,
      {
        getContext: () => ({
          sessionId: 'session-123',
          sessionStartedAt: '2025-01-01T00:00:00.000Z',
        }),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    await collect(model.stream({ input: [], tools: [] }));

    const providerData = seenRequest.providerOptions;
    expect(providerData.extraHeaders).toMatchObject({
      originator: 'codex_exec',
      'x-client-request-id': 'session-123',
      'session-id': 'session-123',
      'thread-id': 'session-123',
      'x-codex-window-id': 'session-123:1',
    });
    expect(providerData.client_metadata).toMatchObject({
      'x-codex-installation-id': 'installation-123',
      session_id: 'session-123',
      thread_id: 'session-123',
      'x-codex-window-id': 'session-123:1',
      ws_request_header_x_openai_internal_codex_responses_lite: 'true',
    });

    const turnMetadata = JSON.parse(providerData.client_metadata['x-codex-turn-metadata']);
    expect(turnMetadata).toMatchObject({
      installation_id: 'installation-123',
      session_id: 'session-123',
      thread_id: 'session-123',
      window_id: 'session-123:1',
      request_kind: 'turn',
    });
    expect(typeof turnMetadata.turn_id).toBe('string');
  } finally {
  }
});

it('CodexResponsesWSModel keeps turn identity stable across response continuations', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      { type: 'response.completed', response: { id: 'resp_stable_identity', output: [], usage: {} } },
    ]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      {
        getOrRefreshAccessToken: async () => 'token',
        getAccountId: () => 'acc_123',
        getInstallationId: () => 'installation-123',
      } as any,
      undefined,
      undefined,
      {
        getContext: () => ({
          sessionId: 'session-123',
          sessionStartedAt: '2025-01-01T00:00:00.000Z',
          traceId: 'turn-123',
        }),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    await collect(model.stream({ input: [], tools: [] }));
    await collect(
      model.stream({
        input: [],
        previousResponseId: 'resp_stable_identity',
        tools: [],
      }),
    );

    expect(seenRequests).toHaveLength(2);
    const firstMetadata = seenRequests[0].providerOptions.client_metadata;
    const secondMetadata = seenRequests[1].providerOptions.client_metadata;
    expect(JSON.parse(firstMetadata['x-codex-turn-metadata']).turn_id).toBe(
      JSON.parse(secondMetadata['x-codex-turn-metadata']).turn_id,
    );
    expect(seenRequests[0].providerOptions.extraHeaders['x-codex-turn-metadata']).toBe(
      seenRequests[1].providerOptions.extraHeaders['x-codex-turn-metadata'],
    );
  } finally {
  }
});

it('CodexResponsesWSModel logs reasoning and tool calls in choice payload matching HTTP/SSE logs', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordResponseClosed() {},
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_reasoning_tool' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_123',
          text: 'Let me think about this request.',
          summary: [],
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_123',
          call_id: 'call_123',
          name: 'shell',
          arguments: '{"command":"ls"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_ws_reasoning_tool',
          output: [],
          usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
        },
      },
    ]);
  };

  const sessionContextService = {
    getContext: () => ({
      sessionId: 'sess_ws_2',
      sessionStartedAt: '2025-01-01T00:00:00.000Z',
      mode: 'websocket',
      traceId: 'trace-session-2',
    }),
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      mockProviderTraffic as any,
      sessionContextService as any,
      transport,
    );
    const request: any = { input: [], tools: [] };

    await collect(model.stream(request));

    expect(trafficCalls.length).toBe(2);
    expect(trafficCalls[0].method).toBe('recordRequestStart');
    expect(trafficCalls[1].method).toBe('recordResponseReceived');

    const receivedInput = trafficCalls[1].args;
    expect(receivedInput.transport).toBe('websocket');
    expect(receivedInput.response).toBeTruthy();
    expect(receivedInput.response.id).toBe('resp_ws_reasoning_tool');
    expect(receivedInput.response.usage).toEqual({ input_tokens: 5, output_tokens: 6, total_tokens: 11 });
    expect(Array.isArray(receivedInput.response.output)).toBe(true);
  } finally {
  }
});

it('CodexResponsesModel unary path runs as stream under the hood', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let receivedStreamArg = false;

  transport.fetchResponse = async function (_request: any, stream: boolean) {
    receivedStreamArg = stream;
    return makeStream([
      { type: 'response.created', response: { id: 'resp_unary' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_unary',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello Unary!' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_unary',
          output: [],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      },
    ]);
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const request: any = { input: [], tools: [] };

    // Call getResponse which defaults to stream: false
    const response: any = await withTrace('test', () => (model as any).fetchUnaryResponse(request));

    expect(receivedStreamArg).toBe(true);
    expect(response.id).toBe('resp_unary');
    expect(response.output.length).toBe(1);
    expect(response.output[0].id).toBe('msg_unary');
    expect(response.usage.total_tokens).toBe(5);
  } finally {
  }
});

it('CodexResponsesWSModel unary path runs as stream under the hood', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let receivedStreamArg = false;

  transport.fetchResponse = async function (_request: any, stream: boolean) {
    receivedStreamArg = stream;
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_unary' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_ws_unary',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello WS Unary!' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_ws_unary',
          output: [],
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        },
      },
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(mockClient as any, 'gpt-5-codex', tokenManager as any, transport);
    const request: any = { input: [], tools: [] };

    // Call getResponse which defaults to stream: false
    const response = await (model as any).fetchUnaryResponse(request);

    expect(receivedStreamArg).toBe(true);
    expect(response.id).toBe('resp_ws_unary');
    expect(response.output.length).toBe(1);
    expect(response.output[0].id).toBe('msg_ws_unary');
    expect(response.usage.total_tokens).toBe(7);
  } finally {
  }
});

it('wrapCodexStream throws a detailed stream error when receiving response.error event', async () => {
  const errorObj = { message: 'Some specific API error description' };
  const eventStream = wrapCodexStream(makeStream([{ type: 'response.error', error: errorObj }]));

  await expect(async () => {
    for await (const _ of eventStream) {
    }
  }).rejects.toThrow('Codex provider stream error: Some specific API error description');
});

it('wrapCodexStream throws when receiving response.error event without error field', async () => {
  const eventStream = wrapCodexStream(makeStream([{ type: 'response.error' }]));

  await expect(async () => {
    for await (const _ of eventStream) {
    }
  }).rejects.toThrow(/^Codex provider stream error:/);
});

it('wrapCodexStream throws a detailed provider error when receiving a failed response status', async () => {
  const errorObj = { message: 'Model context length exceeded' };
  const eventStream = wrapCodexStream(
    makeStream([
      {
        type: 'response.failed',
        response: {
          id: 'resp_failed_1',
          output: [],
          status: 'failed',
          error: errorObj,
        },
      },
    ]),
  );

  await expect(async () => {
    for await (const _ of eventStream) {
    }
  }).rejects.toThrow('Codex provider error: Model context length exceeded');
});

it('CodexResponsesWSModel injects Codex previous response id and trims replayed tool-continuation input', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const toolOutput = {
    type: 'tool_result',
    id: 'call-read',
    output: 'done',
  };
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: seenRequests.length === 1 ? 'resp-1' : 'resp-2',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect' }] }],
      tools: [],
    } as any)) {
    }

    const firstUser = { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect' }] };
    // The opening turn is a single full-history request -- no warmup leg.
    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].previousResponseId).toBeUndefined();
    expect(seenRequests[0].input).toEqual([firstUser]);

    for await (const _event of model.stream({
      input: [
        { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect' }] },
        { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'I will inspect it.' }] },
        { type: 'function_call', call_id: 'call-read', name: 'read_file', arguments: '{}' },
        toolOutput,
      ],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(2);
    expect(seenRequests[1].previousResponseId).toBe('resp-1');
    expect(seenRequests[1].input).toEqual([toolOutput]);

    const latestUser = { type: 'message', role: 'user', content: [{ type: 'text', text: 'summarize' }] };
    for await (const _event of model.stream({
      previousResponseId: 'resp-explicit',
      input: [
        { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect' }] },
        { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'Done.' }] },
        latestUser,
      ],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(3);
    expect(seenRequests[2].previousResponseId).toBe('resp-explicit');
    expect(seenRequests[2].input).toEqual([latestUser]);
  } finally {
  }
});

it('CodexResponsesWSModel uses providerHistoryKey as websocket session identity', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let seenRequest: any;
  transport.fetchResponse = async function (request: any) {
    seenRequest = request;
    return makeStream([
      { type: 'response.completed', response: { id: 'resp_nested_identity', output: [], usage: {} } },
    ]);
  };
  const sessionContextService = new SessionContextService();
  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5.6-luna',
    {
      getOrRefreshAccessToken: async () => 'token',
      getAccountId: () => 'acc_123',
      getInstallationId: () => 'installation-123',
    } as any,
    undefined,
    undefined,
    sessionContextService,
    transport,
  );

  await sessionContextService.runWithContext(
    {
      sessionId: 'parent-session',
      sessionStartedAt: '2026-08-20T00:00:00.000Z',
      providerHistoryKey: 'parent-session:subagent:call-explorer-1',
    },
    () => collect(model.stream({ input: [], tools: [] })),
  );

  expect(seenRequest.providerOptions.extraHeaders['session-id']).toBe('parent-session:subagent:call-explorer-1');
  expect(seenRequest.providerOptions.extraHeaders['thread-id']).toBe('parent-session:subagent:call-explorer-1');
  expect(seenRequest.providerOptions.client_metadata.session_id).toBe('parent-session:subagent:call-explorer-1');
});

it('CodexResponsesWSModel isolates implicit response history for logical runs sharing a foreground session', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const sessionContextService = new SessionContextService();
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    const userMessage = request.input?.find((item: any) => item?.role === 'user');
    const userText = Array.isArray(userMessage?.content) ? userMessage.content[0]?.text : userMessage?.content;
    const responseId =
      userText === 'chain-a' ? 'resp-chain-a' : userText === 'chain-b' ? 'resp-chain-b' : `resp-${seenRequests.length}`;
    return makeStream([
      {
        type: 'response.completed',
        response: { id: responseId, output: [], usage: {} },
      } as any,
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    {
      getOrRefreshAccessToken: async () => 'token',
      getAccountId: () => 'acc_123',
    } as any,
    undefined,
    undefined,
    sessionContextService,
    transport,
  );
  const contextFor = (providerHistoryKey: string) => ({
    sessionId: 'shared-parent-session',
    sessionStartedAt: '2026-07-13T00:00:00.000Z',
    providerHistoryKey,
  });
  const openChain = async (chain: string) => {
    await collect(
      model.stream({
        input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: chain }] }],
        tools: [],
      } as any),
    );
  };

  try {
    await sessionContextService.runWithContext(contextFor('nested-run-a'), () => openChain('chain-a'));
    await sessionContextService.runWithContext(contextFor('nested-run-b'), () => openChain('chain-b'));

    const toolOutput = {
      type: 'tool_result',
      id: 'call-a',
      output: 'result-a',
    };
    await sessionContextService.runWithContext(contextFor('nested-run-a'), () =>
      collect(
        model.stream({
          input: [
            { role: 'user', type: 'message', content: [{ type: 'text', text: 'chain-a' }] },
            { type: 'function_call', call_id: 'call-a', name: 'read_file', arguments: '{}' },
            toolOutput,
          ],
          tools: [],
        } as any),
      ),
    );

    const continuation = seenRequests.at(-1);
    expect(continuation.previousResponseId).not.toBe('resp-chain-b');
    expect(continuation.previousResponseId).toBeTruthy();
    expect(continuation.input).toEqual([toolOutput]);
  } finally {
  }
});

it('CodexResponsesWSModel keeps every interleaved parallel tool output when trimming a tool-continuation delta', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-paired',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  // A prior Codex response issued five parallel function calls — four
  // read_code_outline calls plus a shell. The reconstructed continuation
  // history pairs each call with its result, and the shell pair lands last
  // (it ran after the reads). Only that final result forms a contiguous
  // trailing run, so the legacy delta trim kept just the shell output and
  // dropped the four read outputs, which the server rejected with a 400
  // ("No tool output found for function call …"). The fix must keep every
  // output whose call was produced by the previous response.
  const parallelReads = [1, 2, 3, 4].map((n) => ({
    call: { type: 'function_call', call_id: `call-read-${n}`, name: 'read_code_outline', arguments: '{}' },
    output: { type: 'tool_result', id: `call-read-${n}`, output: `outline-${n}` },
  }));
  const shellPair = {
    call: { type: 'tool_call', id: 'call-shell', name: 'shell', arguments: '{}' },
    output: { type: 'tool_result', id: 'call-shell', output: 'grep result' },
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      previousResponseId: 'resp-prev',
      input: [
        { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect the repo' }] },
        { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'I will inspect it.' }] },
        ...parallelReads.flatMap((pair) => [pair.call, pair.output]),
        shellPair.call,
        shellPair.output,
      ],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-prev');
    expect(seenRequests[0].input).toEqual([...parallelReads.map((pair) => pair.output), shellPair.output]);
  } finally {
  }
});

it('CodexResponsesWSModel drops tool outputs already consumed by the previous response', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    const responseIds = ['resp-after-first-batch', 'resp-after-second-batch', 'resp-after-third-batch'];
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: responseIds[seenRequests.length - 1],
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  const firstBatch = [1, 2].map((n) => ({
    type: 'tool_result',
    id: `call-already-sent-${n}`,
    output: `old-${n}`,
  }));
  const nextOutput = {
    type: 'tool_result',
    id: 'call-current',
    output: 'current',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-consumed-tool-outputs', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      previousResponseId: 'resp-tool-calls-1',
      input: firstBatch,
      tools: [],
    } as any)) {
    }

    for await (const _event of model.stream({
      previousResponseId: 'resp-after-first-batch',
      input: [...firstBatch, nextOutput],
      tools: [],
    } as any)) {
    }

    for await (const _event of model.stream({
      previousResponseId: 'resp-after-second-batch',
      input: [nextOutput],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(3);
    expect(seenRequests[0].previousResponseId).toBe('resp-tool-calls-1');
    expect(seenRequests[0].input).toEqual(firstBatch);
    expect(seenRequests[1].previousResponseId).toBe('resp-after-first-batch');
    expect(seenRequests[1].input).toEqual([nextOutput]);
    expect(seenRequests[2].previousResponseId).toBe('resp-after-second-batch');
    expect(seenRequests[2].input).toEqual([]);
  } finally {
  }
});

it('CodexResponsesWSModel marks transport failure after buffered raw frames as ambiguous', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let attempts = 0;
  const networkError = new Error('Responses websocket connection closed before response completed (code=1006)');
  transport.fetchResponse = async function () {
    attempts += 1;
    return (async function* () {
      yield { type: 'response.reasoning_summary_text.delta', delta: 'buffered reasoning' };
      throw networkError;
    })();
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      transport,
    );
    const retrying = new RetryingModel(model, { retryAttempts: 2, sleep: async () => {} });

    await expect(
      collect(
        retrying.stream({
          input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: [],
        }),
      ),
    ).rejects.toBeInstanceOf(AmbiguousModelOutcomeError);
    expect(attempts).toBe(1);
  } finally {
  }
});

it('CodexResponsesWSModel marks close before terminal as ambiguous even without raw frames', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let attempts = 0;
  // Incomplete-stream class: transportFallback stays false, but the request may
  // already have been accepted — RetryingModel must not replay.
  const closeError = new Error('Codex WebSocket connection closed before a terminal response event.');
  transport.fetchResponse = async function () {
    attempts += 1;
    return (async function* () {
      throw closeError;
    })();
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    transport,
  );
  const retrying = new RetryingModel(model, { retryAttempts: 2, sleep: async () => {} });

  await expect(
    collect(
      retrying.stream({
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
      }),
    ),
  ).rejects.toMatchObject({
    name: 'AmbiguousModelOutcomeError',
    unsafeToReplay: true,
  });
  expect(attempts).toBe(1);
});

it('CodexResponsesWSModel drops interleaved tool calls from an already-trimmed tool-continuation delta', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-trimmed-paired',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };
  const pairs = [1, 2].map((n) => ({
    call: { type: 'function_call', call_id: `call-${n}`, name: 'read_code_outline', arguments: '{}' },
    output: { type: 'tool_result', id: `call-${n}`, output: `outline-${n}` },
  }));

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      previousResponseId: 'resp-prev',
      input: pairs.flatMap((pair) => [pair.call, pair.output]),
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-prev');
    expect(seenRequests[0].input).toEqual(pairs.map((pair) => pair.output));
  } finally {
  }
});

it('CodexResponsesWSModel keeps interleaved outputs when function calls only carry item ids', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-item-id-paired',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };
  const pairs = [1, 2, 3].map((n) => ({
    call: { type: 'function_call', id: `fc-${n}`, name: 'shell', arguments: '{}' },
    output: { type: 'tool_result', id: `call-${n}`, output: `result-${n}` },
  }));

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      previousResponseId: 'resp-prev',
      input: pairs.flatMap((pair) => [pair.call, pair.output]),
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-prev');
    expect(seenRequests[0].input).toEqual(pairs.map((pair) => pair.output));
  } finally {
  }
});

it('CodexResponsesWSModel sends interleaved tool continuations as one complete logical request', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: seenRequests.length === 1 ? 'resp-warmup' : 'resp-main',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  const openingUser = { type: 'message', role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] };
  const openingAssistant = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'I will inspect it.' }],
  };
  const parallelReads = [1, 2].map((n) => ({
    call: { type: 'tool_call', id: `call-read-${n}`, name: 'read_code_outline', arguments: '{}' },
    output: { type: 'tool_result', id: `call-read-${n}`, output: `outline-${n}` },
  }));
  const shellPair = {
    call: { type: 'tool_call', id: 'call-shell', name: 'shell', arguments: '{}' },
    output: { type: 'tool_result', id: 'call-shell', output: 'grep result' },
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      input: [
        openingUser,
        openingAssistant,
        ...parallelReads.flatMap((pair) => [pair.call, pair.output]),
        shellPair.call,
        shellPair.output,
      ],
      tools: [],
    } as any)) {
    }

    const completeHistory = [
      openingUser,
      openingAssistant,
      ...parallelReads.flatMap((pair) => [pair.call, pair.output]),
      shellPair.call,
      shellPair.output,
    ];
    // Interleaved tool continuations go out as one complete logical request.
    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].previousResponseId).toBe(undefined);
    expect(seenRequests[0].input).toEqual(completeHistory);
  } finally {
  }
});

it('CodexResponsesWSModel sends a cold request once, with no generate:false warmup leg', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      { type: 'response.completed', response: { id: `resp-${seenRequests.length}`, output: [], usage: {} } } as any,
    ]);
  };

  const history = [
    { role: 'user', type: 'message', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'first response' }] },
    { role: 'user', type: 'message', content: [{ type: 'text', text: 'second' }] },
  ];

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    undefined,
    {
      getContext: () => ({ sessionId: 'session-no-warmup', traceId: 'trace-no-warmup' } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    },
    transport,
  );

  await collect(model.stream({ input: history, tools: [] } as any));

  // A warmup leg would upload this same history a second time. Codex reports the
  // paired generate call's prompt as fully uncached, so the duplicate is charged
  // rather than deduplicated -- which is why there is exactly one request here.
  expect(seenRequests).toHaveLength(1);
  expect(seenRequests[0].providerOptions?.generate).toBeUndefined();
  expect(seenRequests[0].previousResponseId).toBeUndefined();
  expect(seenRequests[0].input).toEqual(history);

  // The single generate response still anchors the next turn's chain.
  await collect(
    model.stream({
      input: [...history, { role: 'user', type: 'message', content: [{ type: 'text', text: 'third' }] }],
      tools: [],
    } as any),
  );
  expect(seenRequests).toHaveLength(2);
  expect(seenRequests[1].previousResponseId).toBe('resp-1');
});

it('CodexResponsesWSModel leaves connection failures to the outer retry policy', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const networkError = Object.assign(new Error('Responses websocket connection closed before opening.'), {
    code: 'connection_closed_before_opening',
  });
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    if (seenRequests.length === 1) {
      throw networkError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-full-history',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };
  const fullInput = [
    { role: 'user', type: 'message', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'first response' }] },
    { role: 'user', type: 'message', content: [{ type: 'text', text: 'next' }] },
  ];

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-warmup-repro', traceId: 'trace-warmup-repro' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await expect(async () => {
      for await (const _event of model.stream({
        input: fullInput,
        tools: [],
      } as any)) {
      }
    }).rejects.toBe(networkError);

    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].providerOptions?.generate).toBeUndefined();
    expect(seenRequests[0].input).toEqual(fullInput);
  } finally {
  }
});

it('CodexResponsesWSModel preserves a tool-call chain when the websocket connection lifetime expires', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const trafficBodies: any[] = [];
  const networkError = Object.assign(
    new Error(
      'Responses websocket error: {"error":{"code":"websocket_connection_limit_reached","message":"Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue."},"status":400}',
    ),
    { status: 400 },
  );
  const functionCall = {
    id: 'fc_1',
    type: 'function_call',
    call_id: 'call_tool_1',
    name: 'run_subagent_async',
    arguments: '{}',
  };
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    if (seenRequests.length === 1) {
      return makeStream([
        {
          type: 'response.completed',
          response: {
            id: 'resp-tool-call',
            output: [functionCall],
            usage: {},
          },
        } as any,
      ]);
    }

    if (seenRequests.length === 2) {
      throw networkError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-recovered',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };
  const continuationInput = [
    { role: 'user', type: 'message', content: [{ type: 'text', text: 'start the worker' }] },
    {
      type: 'tool_result',
      id: 'call_tool_1',
      output: 'worker is running',
    },
  ];

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-network-repro', traceId: 'trace-network-repro' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await collect(
      model.stream({
        previousResponseId: 'resp-root',
        input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: 'start the worker' }] }],
        tools: [],
      } as any),
    );

    await expect(
      collect(
        model.stream({
          input: continuationInput,
          tools: [],
        } as any),
      ),
    ).rejects.toBe(networkError);

    expect(trafficBodies).toHaveLength(2);
    expect(trafficBodies[1].previous_response_id).toBe('resp-tool-call');
    expect(trafficBodies[1].input).toEqual([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_tool_1' }),
    ]);

    await collect(
      model.stream({
        input: continuationInput,
        tools: [],
      } as any),
    );

    expect(seenRequests).toHaveLength(3);
    expect(trafficBodies).toHaveLength(3);
    expect(trafficBodies[2].previous_response_id).toBe('resp-tool-call');
    expect(trafficBodies[2].input).toEqual([
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_tool_1',
        output: 'worker is running',
      }),
    ]);
    expect(trafficBodies[2].input).not.toContainEqual(expect.objectContaining({ type: 'function_call' }));
    expect(trafficBodies[2].generate).not.toBe(false);
  } finally {
  }
});

it('CodexResponsesWSModel preserves tool output when a user steer message follows tool results mid-turn', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficBodies: any[] = [];
  let requestCount = 0;
  transport.fetchResponse = async function (request: any, stream: boolean, requestData: any) {
    requestCount++;
    if (requestCount === 1) {
      return makeStream([
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
            call_id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
            name: 'shell',
            arguments: '{"command":"ls"}',
          },
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-tool-call',
            output: [
              {
                type: 'function_call',
                id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
                call_id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
                name: 'shell',
                arguments: '{"command":"ls"}',
              },
            ],
          },
        },
      ]);
    }
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-steered-turn',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Steer processed' }] }],
        },
      },
    ]);
  };

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    {
      getContext: () => ({ sessionId: 'session-steer-test', traceId: 'trace-steer-test' } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    },
    transport,
  );

  // Turn 1: initial user message
  await collect(
    model.stream({
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'initial question' }] }],
      tools: [],
    } as any),
  );

  // Turn 2: tool result + steer message injected mid-turn
  const steeredInput = [
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'initial question' }] },
    { type: 'tool_call', id: 'call_dUY49XDM2PcYLUlN0vQzCeKO', name: 'shell', arguments: '{"command":"ls"}' },
    { type: 'tool_result', id: 'call_dUY49XDM2PcYLUlN0vQzCeKO', output: 'file1.txt\nfile2.txt' },
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'steering message injected mid-turn' }] },
  ];

  await collect(
    model.stream({
      input: steeredInput,
      previousResponseId: 'resp-tool-call',
      tools: [],
    } as any),
  );

  expect(trafficBodies).toHaveLength(2);
  expect(trafficBodies[1].previous_response_id).toBe('resp-tool-call');
  // The Responses-Lite `additional_tools` prefix is not re-sent: turn 1 is now a
  // single request, so the response this turn chains onto is the same one that
  // already carries the prefix.
  expect(trafficBodies[1].input).toEqual([
    expect.objectContaining({
      type: 'function_call_output',
      call_id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
      output: 'file1.txt\nfile2.txt',
    }),
    expect.objectContaining({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'steering message injected mid-turn' }],
    }),
  ]);
});

it('CodexResponsesWSModel invalidates Luna wire state on previous_response_not_found error', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  let rejectedChainedContinuation = false;
  const prevNotFoundError = Object.assign(new Error('Previous response not found for id resp_stale'), {
    code: 'previous_response_not_found',
  });
  transport.fetchResponse = async function (request: any, _stream: boolean, requestData?: any) {
    const payload = requestData ?? request;
    seenRequests.push(payload);

    const isChainedContinuation =
      (payload.previousResponseId === 'resp_luna_ok' || payload.previous_response_id === 'resp_luna_ok') &&
      payload.input?.some((item: any) => item?.content?.[0]?.text === 'continue');
    if (isChainedContinuation && !rejectedChainedContinuation) {
      rejectedChainedContinuation = true;
      throw prevNotFoundError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: { id: 'resp_luna_ok', output: [], usage: {} },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5.6-luna',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-luna-err', traceId: 'trace-luna-err' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    const userMsg = { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] };
    const userMsg2 = { type: 'message', role: 'user', content: [{ type: 'text', text: 'continue' }] };

    // First request: succeeds, establishes stored state.
    await collect(
      model.stream({
        input: [userMsg],
        instructions: 'Do it.',
        tools: [],
      } as any),
    );

    // Second request: chains off the first (wire state supplies previous response id), but fails with prev-not-found.
    // The error triggers invalidation, then the fallback sends full input.
    await collect(
      model.stream({
        input: [userMsg, userMsg2],
        instructions: 'Do it.',
        tools: [],
      } as any),
    );

    // After invalidation, the exact fallback request replays full history
    // without trying to continue the stale response chain.
    expect(rejectedChainedContinuation).toBe(true);
    const failedRequestIndex = seenRequests.findIndex(
      (candidate) =>
        (candidate.previousResponseId === 'resp_luna_ok' || candidate.previous_response_id === 'resp_luna_ok') &&
        candidate.input?.some((item: any) => item?.content?.[0]?.text === 'continue'),
    );
    const fallbackRequests = seenRequests.slice(failedRequestIndex + 1);
    expect(fallbackRequests).not.toHaveLength(0);
    expect(fallbackRequests[0].previousResponseId).toBeUndefined();
    expect(fallbackRequests[0].previous_response_id).toBeUndefined();
    expect(fallbackRequests.flatMap((candidate) => candidate.input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: [{ type: 'input_text', text: 'hello' }] }),
        expect.objectContaining({ content: [{ type: 'input_text', text: 'continue' }] }),
      ]),
    );
  } finally {
  }
});

it('CodexResponsesWSModel invalidates Luna wire state on invalid previous_response_id error payload', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  let rejectedChainedContinuation = false;
  const invalidPrevResponseIdError = Object.assign(
    new Error(
      'Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid `previous_response_id`."}}',
    ),
    { status: 400 },
  );
  transport.fetchResponse = async function (request: any, _stream: boolean, requestData?: any) {
    const payload = requestData ?? request;
    seenRequests.push(payload);

    const isChainedContinuation =
      (payload.previousResponseId === 'resp_luna_ok' || payload.previous_response_id === 'resp_luna_ok') &&
      payload.input?.some((item: any) => item?.content?.[0]?.text === 'continue');
    if (isChainedContinuation && !rejectedChainedContinuation) {
      rejectedChainedContinuation = true;
      throw invalidPrevResponseIdError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: { id: 'resp_luna_ok', output: [], usage: {} },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5.6-luna',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-luna-invalid-err', traceId: 'trace-luna-invalid-err' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    const userMsg = { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] };
    const userMsg2 = { type: 'message', role: 'user', content: [{ type: 'text', text: 'continue' }] };

    // First request: succeeds, establishes stored state.
    await collect(
      model.stream({
        input: [userMsg],
        instructions: 'Do it.',
        tools: [],
      } as any),
    );

    // Second request: chains off the first (wire state supplies previous response id), but fails with invalid previous_response_id.
    // The error triggers invalidation, then the fallback sends full input.
    await collect(
      model.stream({
        input: [userMsg, userMsg2],
        instructions: 'Do it.',
        tools: [],
      } as any),
    );

    expect(rejectedChainedContinuation).toBe(true);
    const failedRequestIndex = seenRequests.findIndex(
      (candidate) =>
        (candidate.previousResponseId === 'resp_luna_ok' || candidate.previous_response_id === 'resp_luna_ok') &&
        candidate.input?.some((item: any) => item?.content?.[0]?.text === 'continue'),
    );
    const fallbackRequests = seenRequests.slice(failedRequestIndex + 1);
    expect(fallbackRequests).not.toHaveLength(0);
    expect(fallbackRequests[0].previousResponseId).toBeUndefined();
    expect(fallbackRequests[0].previous_response_id).toBeUndefined();
    expect(fallbackRequests.flatMap((candidate) => candidate.input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: [{ type: 'input_text', text: 'hello' }] }),
        expect.objectContaining({ content: [{ type: 'input_text', text: 'continue' }] }),
      ]),
    );
  } finally {
  }
});

it('CodexResponsesWSModel invalidates standard model wire state on invalid previous_response_id error payload in streaming path', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  let rejectedChainedContinuation = false;
  const invalidPrevResponseIdError = Object.assign(
    new Error(
      'Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid `previous_response_id`."}}',
    ),
    { status: 400 },
  );
  transport.fetchResponse = async function (request: any, _stream: boolean, requestData?: any) {
    const payload = requestData ?? request;
    seenRequests.push(payload);

    const isChainedContinuation =
      (payload.previousResponseId === 'resp_std_stream_1' || payload.previous_response_id === 'resp_std_stream_1') &&
      payload.input?.some((item: any) => item?.content?.[0]?.text === 'continue');
    if (isChainedContinuation && !rejectedChainedContinuation) {
      rejectedChainedContinuation = true;
      throw invalidPrevResponseIdError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: rejectedChainedContinuation ? 'resp_std_stream_fallback' : 'resp_std_stream_1',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () =>
          ({ sessionId: 'session-std-stream-invalid-err', traceId: 'trace-std-stream-invalid-err' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    const userMsg = { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] };
    const userMsg2 = { type: 'message', role: 'user', content: [{ type: 'text', text: 'continue' }] };

    // 1. Initial request succeeds, establishing stored server history
    await collect(
      model.stream({
        input: [userMsg],
        instructions: 'Do it.',
        tools: [],
      } as any),
    );

    // 2. Chained request fails with invalid previous_response_id, then falls back to full input
    const results = await collect(
      model.stream({
        input: [userMsg, userMsg2],
        instructions: 'Do it.',
        tools: [],
      } as any),
    );

    expect(rejectedChainedContinuation).toBe(true);
    const failedRequestIndex = seenRequests.findIndex(
      (candidate) =>
        (candidate.previousResponseId === 'resp_std_stream_1' ||
          candidate.previous_response_id === 'resp_std_stream_1') &&
        candidate.input?.some((item: any) => item?.content?.[0]?.text === 'continue'),
    );
    const fallbackRequests = seenRequests.slice(failedRequestIndex + 1);
    expect(fallbackRequests).not.toHaveLength(0);
    expect(fallbackRequests[0].previousResponseId).toBeUndefined();
    expect(fallbackRequests[0].previous_response_id).toBeUndefined();
    expect(fallbackRequests.flatMap((candidate) => candidate.input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: [{ type: 'input_text', text: 'hello' }] }),
        expect.objectContaining({ content: [{ type: 'input_text', text: 'continue' }] }),
      ]),
    );
    expect(results.some((event: any) => event.type === 'completion')).toBe(true);
  } finally {
  }
});

it('CodexResponsesWSModel invalidates standard model wire state on invalid previous_response_id error payload in unary path', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  let rejectedChainedContinuation = false;
  const invalidPrevResponseIdError = Object.assign(
    new Error(
      'Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid `previous_response_id`."}}',
    ),
    { status: 400 },
  );
  transport.fetchResponse = async function (request: any, _stream: boolean, requestData?: any) {
    const payload = requestData ?? request;
    seenRequests.push(payload);

    const isChainedContinuation =
      (payload.previousResponseId === 'resp_std_unary_1' || payload.previous_response_id === 'resp_std_unary_1') &&
      payload.input?.some((item: any) => item?.content?.[0]?.text === 'continue');
    if (isChainedContinuation && !rejectedChainedContinuation) {
      rejectedChainedContinuation = true;
      throw invalidPrevResponseIdError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: rejectedChainedContinuation ? 'resp_std_unary_fallback' : 'resp_std_unary_1',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () =>
          ({ sessionId: 'session-std-unary-invalid-err', traceId: 'trace-std-unary-invalid-err' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    const userMsg = { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] };
    const userMsg2 = { type: 'message', role: 'user', content: [{ type: 'text', text: 'continue' }] };

    // 1. Initial unary request succeeds, establishing stored server history
    await (model as any).fetchUnaryResponse({
      input: [userMsg],
      instructions: 'Do it.',
      tools: [],
    } as any);

    // 2. Chained unary request fails with invalid previous_response_id, then falls back to full input
    const response = await (model as any).fetchUnaryResponse({
      input: [userMsg, userMsg2],
      instructions: 'Do it.',
      tools: [],
    } as any);

    expect(rejectedChainedContinuation).toBe(true);
    const failedRequestIndex = seenRequests.findIndex(
      (candidate) =>
        (candidate.previousResponseId === 'resp_std_unary_1' ||
          candidate.previous_response_id === 'resp_std_unary_1') &&
        candidate.input?.some((item: any) => item?.content?.[0]?.text === 'continue'),
    );
    const fallbackRequests = seenRequests.slice(failedRequestIndex + 1);
    expect(fallbackRequests).not.toHaveLength(0);
    expect(fallbackRequests[0].previousResponseId).toBeUndefined();
    expect(fallbackRequests[0].previous_response_id).toBeUndefined();
    expect(fallbackRequests.flatMap((candidate) => candidate.input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: [{ type: 'input_text', text: 'hello' }] }),
        expect.objectContaining({ content: [{ type: 'input_text', text: 'continue' }] }),
      ]),
    );
    expect(response.id).toBe('resp_std_unary_fallback');
  } finally {
  }
});

it('CodexResponsesWSModel invalidates Luna wire state on invalid previous_response_id error payload in unary path', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  let rejectedChainedContinuation = false;
  const invalidPrevResponseIdError = Object.assign(
    new Error(
      'Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid `previous_response_id`."}}',
    ),
    { status: 400 },
  );
  transport.fetchResponse = async function (request: any, _stream: boolean, requestData?: any) {
    const payload = requestData ?? request;
    seenRequests.push(payload);

    const isChainedContinuation =
      (payload.previousResponseId === 'resp_luna_unary_1' || payload.previous_response_id === 'resp_luna_unary_1') &&
      payload.input?.some((item: any) => item?.content?.[0]?.text === 'continue');
    if (isChainedContinuation && !rejectedChainedContinuation) {
      rejectedChainedContinuation = true;
      throw invalidPrevResponseIdError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: rejectedChainedContinuation ? 'resp_luna_unary_fallback' : 'resp_luna_unary_1',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5.6-luna',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () =>
          ({ sessionId: 'session-luna-unary-invalid-err', traceId: 'trace-luna-unary-invalid-err' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    const userMsg = { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] };
    const userMsg2 = { type: 'message', role: 'user', content: [{ type: 'text', text: 'continue' }] };

    // 1. Initial unary request succeeds, establishing stored wire state
    await (model as any).fetchUnaryResponse({
      input: [userMsg],
      instructions: 'Do it.',
      tools: [],
    } as any);

    // 2. Chained unary request fails with invalid previous_response_id, then falls back to full input
    const response = await (model as any).fetchUnaryResponse({
      input: [userMsg, userMsg2],
      instructions: 'Do it.',
      tools: [],
    } as any);

    expect(rejectedChainedContinuation).toBe(true);
    const failedRequestIndex = seenRequests.findIndex(
      (candidate) =>
        (candidate.previousResponseId === 'resp_luna_unary_1' ||
          candidate.previous_response_id === 'resp_luna_unary_1') &&
        candidate.input?.some((item: any) => item?.content?.[0]?.text === 'continue'),
    );
    const fallbackRequests = seenRequests.slice(failedRequestIndex + 1);
    expect(fallbackRequests).not.toHaveLength(0);
    expect(fallbackRequests[0].previousResponseId).toBeUndefined();
    expect(fallbackRequests[0].previous_response_id).toBeUndefined();
    expect(fallbackRequests.flatMap((candidate) => candidate.input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: [{ type: 'input_text', text: 'hello' }] }),
        expect.objectContaining({ content: [{ type: 'input_text', text: 'continue' }] }),
      ]),
    );
    expect(response.id).toBe('resp_luna_unary_fallback');
  } finally {
  }
});

it('CodexResponsesWSModel does not retry a caller-supplied chained delta after invalid previous_response_id', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const invalidPrevResponseIdError = Object.assign(
    new Error(
      'Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid `previous_response_id`."}}',
    ),
    { status: 400 },
  );
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    throw invalidPrevResponseIdError;
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };
  const model = new CodexResponsesWSModel(
    mockClient as any,
    'gpt-5.3-codex',
    tokenManager as any,
    undefined,
    undefined,
    {
      getContext: () => ({ sessionId: 'session-lossy-delta', traceId: 'trace-lossy-delta' } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    },
    transport,
  );

  await expect(
    collect(
      model.stream({
        previousResponseId: 'resp-stale',
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'This' }] }],
        tools: [],
      } as any),
    ),
  ).rejects.toThrow(/previous_response_id/i);

  expect(seenRequests).toHaveLength(1);
  expect(seenRequests[0].previousResponseId).toBe('resp-stale');
});

it('CodexResponsesWSModel allows unchained chain_recovery fallback after Luna invalid previous_response_id', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  let shouldFailNext = false;
  const invalidPrevResponseIdError = Object.assign(
    new Error(
      'Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid `previous_response_id`."}}',
    ),
    { status: 400 },
  );
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    if (shouldFailNext) {
      shouldFailNext = false;
      throw invalidPrevResponseIdError;
    }
    return makeStream([
      {
        type: 'response.completed',
        response: { id: 'resp_luna_1', output: [], usage: {} },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  const model = new CodexResponsesWSModel(
    mockClient as any,
    'gpt-5.6-luna',
    tokenManager as any,
    undefined,
    undefined,
    {
      getContext: () => ({ sessionId: 'session-luna-recovery', traceId: 'trace-luna-recovery' } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    },
    transport,
  );

  const userMsg = { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] };
  const functionCall = { type: 'tool_call', id: 'call_1', name: 'bash', arguments: '{}' };
  const toolResult = { type: 'tool_result', id: 'call_1', output: 'ok' };

  // 1. Initial request succeeds, establishing stored wire state
  await collect(
    model.stream({
      input: [userMsg],
      tools: [],
    } as any),
  );

  // 2. Next turn fails with invalid previous_response_id
  shouldFailNext = true;
  await expect(
    collect(
      model.stream({
        input: [userMsg, functionCall, toolResult],
        tools: [],
      } as any),
    ),
  ).rejects.toThrow();

  // 3. Retry with disableChaining: true must succeed without ConversationStateNoProgressError
  const retryEvents = await collect(
    model.stream({
      input: [userMsg, functionCall, toolResult],
      tools: [],
      disableChaining: true,
    } as any),
  );

  expect(retryEvents.some((event: any) => event.type === 'completion')).toBe(true);
});

it('CodexResponsesWSModel propagates stale tool continuations instead of replaying orphaned outputs', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const previousResponseNotFound = Object.assign(new Error('Previous response not found for id resp-stale'), {
    code: 'previous_response_not_found',
  });
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    throw previousResponseNotFound;
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-stale-tool', traceId: 'trace-stale-tool' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await expect(
      collect(
        model.stream({
          previousResponseId: 'resp-stale',
          input: [
            { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect the repo' }] },
            {
              type: 'tool_result',
              id: 'call-orphaned-output',
              output: 'tool output from the missing response',
            },
          ],
          tools: [],
        } as any),
      ),
    ).rejects.toMatchObject({ code: 'previous_response_not_found' });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-stale');
  } finally {
  }
});

it('CodexResponsesWSModel drops orphaned tool outputs before creating a warmup chain', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const serverCallIds = new Set<string>();
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    for (const item of request.input ?? []) {
      if (item?.type === 'function_call' && typeof item.callId === 'string') {
        serverCallIds.add(item.callId);
      }
      if (item?.type === 'function_call_result' && typeof item.callId === 'string' && !serverCallIds.has(item.callId)) {
        throw new Error(`No tool call found for function call output with call_id ${item.callId}.`);
      }
    }

    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: request.providerOptions?.generate === false ? 'resp-warmup' : 'resp-completed',
          output: [],
          usage: {},
        },
      },
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-orphan-warmup', traceId: 'trace-orphan-warmup' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await collect(
      model.stream({
        input: [
          { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect the repo' }] },
          { type: 'reasoning', content: [] },
          {
            type: 'tool_result',
            id: 'call-orphaned-output',
            output: 'tool output from a discarded response chain',
          },
        ],
        tools: [],
      } as any),
    );

    expect(seenRequests.flatMap((request) => request.input ?? [])).not.toContainEqual(
      expect.objectContaining({ id: 'call-orphaned-output' }),
    );
  } finally {
  }
});

it('CodexResponsesWSModel does not chain a tool output whose call is absent from a rebuilt response chain', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const orphanedCallId = 'call-rebuilt-chain-orphan';
  const functionCall = {
    type: 'tool_call',
    id: orphanedCallId,
    name: 'apply_patch',
    arguments: '{}',
  };
  const functionCallOutput = {
    type: 'tool_result',
    id: orphanedCallId,
    output: 'Updated source/providers/openai.provider.ts',
    status: 'completed',
  };
  const noToolCallForOutput = new Error(`No tool call found for function call output with call_id ${orphanedCallId}.`);
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    if (request.input?.some((item: any) => (item?.call_id ?? item?.callId) === orphanedCallId)) {
      throw noToolCallForOutput;
    }
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-rebuilt-chain',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };
  const openingUser = { type: 'message', role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-rebuilt-chain-orphan', traceId: 'trace-rebuilt-chain-orphan' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    // The rebuilt chain is established without the in-flight function call.
    await collect(
      model.stream({
        input: [openingUser],
        tools: [],
      } as any),
    );

    await expect(
      collect(
        model.stream({
          previousResponseId: 'resp-rebuilt-chain',
          input: [openingUser, functionCall, functionCallOutput],
          tools: [],
        } as any),
      ),
    ).rejects.toMatchObject({
      name: 'OrphanedChainedToolOutputError',
      callIds: [orphanedCallId],
    });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests).not.toContainEqual(
      expect.objectContaining({
        input: expect.arrayContaining([expect.objectContaining({ id: orphanedCallId })]),
      }),
    );
  } finally {
  }
});

it('CodexResponsesWSModel unary path propagates stale tool continuations without fallback', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const previousResponseNotFound = Object.assign(new Error('Previous response not found for id resp-stale-unary'), {
    code: 'previous_response_not_found',
  });
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    throw previousResponseNotFound;
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-stale-tool-unary', traceId: 'trace-stale-tool-unary' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await expect(
      (model as any).fetchUnaryResponse({
        previousResponseId: 'resp-stale-unary',
        input: [
          { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect the repo' }] },
          {
            type: 'tool_result',
            id: 'call-orphaned-output-unary',
            output: 'tool output from the missing response',
          },
        ],
        tools: [],
      } as any),
    ).rejects.toMatchObject({ code: 'previous_response_not_found' });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-stale-unary');
  } finally {
  }
});

it('CodexResponsesWSModel unary path records Luna wire state response with correct token', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficBodies: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  transport.fetchResponse = async function () {
    responseCount += 1;
    return makeStream([
      {
        type: 'response.completed',
        response: { id: `resp_unary_luna_${responseCount}`, output: [], usage: {} },
      },
    ]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-unary-token', traceId: 'trace-unary-token' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    const msg1 = { role: 'user', type: 'message', content: [{ type: 'text', text: 'unary first' }] };
    const msg2 = { role: 'user', type: 'message', content: [{ type: 'text', text: 'unary second' }] };

    // First unary call establishes stored state.
    await (model as any).fetchUnaryResponse({
      input: [msg1],
      instructions: 'Do it.',
      tools: [],
    } as any);

    // Second unary call chains off first and should produce a delta.
    await (model as any).fetchUnaryResponse({
      previousResponseId: 'resp_unary_luna_1',
      input: [msg1, msg2],
      instructions: 'Do it.',
      tools: [],
    } as any);

    // The second call (the second traffic entry, now that the first call is a
    // single request) should carry only the new user message as a delta.
    expect(trafficBodies).toHaveLength(2);
    expect(trafficBodies[1].previous_response_id).toBe('resp_unary_luna_1');
    expect(trafficBodies[1].input).toEqual([
      expect.objectContaining({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'unary second' }],
      }),
    ]);
  } finally {
  }
});

it('CodexResponsesWSModel gives the SDK a composed request signal before receiving websocket events', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const external = new AbortController();
  let sdkSignal: AbortSignal | undefined;
  transport.fetchResponse = async function (request: any) {
    sdkSignal = request.signal;
    return makeStream([{ type: 'response.completed', response: { id: 'resp_1', output: [], usage: {} } }]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
      transport,
    );

    await collect(
      model.stream({
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
        signal: external.signal,
      } as any),
    );

    expect(sdkSignal).toBeDefined();
    expect(sdkSignal).not.toBe(external.signal);
    expect(sdkSignal?.aborted).toBe(false);
  } finally {
  }
});

const ORPHAN_RESUME_CALL_ID = 'call_TPLbZgMcqd0guPBWHwDh1zjK';
const STALE_WARMUP_RESPONSE_ID = 'resp_0c92da9f3e21513a006a7ca6ae955081919d93791700e69a20';

const wrappedFunctionCall = (callId: string) => ({
  type: 'tool_call',
  id: callId,
  callId,
  name: 'shell',
  arguments: '{"command":"pwd"}',
  rawItem: {
    type: 'function_call',
    call_id: callId,
    name: 'shell',
    arguments: '{"command":"pwd"}',
  },
});

const wrappedFunctionCallOutput = (callId: string) => ({
  type: 'tool_result',
  id: callId,
  callId,
  output: '/workspace',
  rawItem: {
    type: 'function_call_output',
    call_id: callId,
    output: '/workspace',
  },
});

const resumedCorruptHistory = () => [
  { type: 'message', role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] },
  { type: 'reasoning', content: [] },
  { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }] },
  wrappedFunctionCall(ORPHAN_RESUME_CALL_ID),
  wrappedFunctionCallOutput(ORPHAN_RESUME_CALL_ID),
  { type: 'message', role: 'user', content: [{ type: 'text', text: 'continue from the last result' }] },
];

const collectToolOutputCallIds = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item: any) => {
    const raw = item?.rawItem ?? item;
    const type = raw?.type ?? item?.type;
    if (type !== 'function_call_output' && type !== 'function_call_result' && type !== 'tool_result') {
      return [];
    }
    const callId = raw?.call_id ?? raw?.callId ?? item?.callId ?? item?.id;
    return typeof callId === 'string' ? [callId] : [];
  });
};

const collectFunctionCallIdsFromInput = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item: any) => {
    const raw = item?.rawItem ?? item;
    const type = raw?.type ?? item?.type;
    if (type !== 'function_call' && type !== 'tool_call') return [];
    const callId = raw?.call_id ?? raw?.callId ?? item?.callId ?? item?.id;
    return typeof callId === 'string' ? [callId] : [];
  });
};

const createRejectingOrphanCodexTransport = () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const callsByResponseId = new Map<string, Set<string>>();
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    const responseId =
      request.providerOptions?.generate === false
        ? `resp-warmup-${seenRequests.length}`
        : `resp-generated-${seenRequests.length}`;
    const knownCalls = new Set(collectFunctionCallIdsFromInput(request.input));
    const previousId = request.previousResponseId;
    if (typeof previousId === 'string') {
      for (const callId of callsByResponseId.get(previousId) ?? []) {
        knownCalls.add(callId);
      }
    }
    for (const callId of collectToolOutputCallIds(request.input)) {
      if (!knownCalls.has(callId)) {
        throw new Error(`No tool call found for function call output with call_id ${callId}.`);
      }
    }
    callsByResponseId.set(responseId, knownCalls);
    return makeStream([
      {
        type: 'response.completed',
        response: { id: responseId, output: [], usage: {} },
      },
    ]);
  };
  return { transport, seenRequests };
};

const createCodexWsModel = (transport: CodexResponsesTransport, sessionId: string) =>
  new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    undefined,
    {
      getContext: () => ({ sessionId, traceId: `trace-${sessionId}` } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    },
    transport,
  );

it('resumed Codex history with a stale warmup chain sends the captured orphan output', async () => {
  const { transport, seenRequests } = createRejectingOrphanCodexTransport();
  const model = createCodexWsModel(transport, 'session-corrupt-resume');

  await expect(
    collect(
      model.stream({
        previousResponseId: STALE_WARMUP_RESPONSE_ID,
        input: resumedCorruptHistory(),
        tools: [],
      } as any),
    ),
  ).rejects.toThrow(`No tool call found for function call output with call_id ${ORPHAN_RESUME_CALL_ID}.`);

  expect(seenRequests).toHaveLength(1);
  expect(seenRequests[0].previousResponseId).toBe(STALE_WARMUP_RESPONSE_ID);
  expect(collectToolOutputCallIds(seenRequests[0].input)).toContain(ORPHAN_RESUME_CALL_ID);
  expect(collectFunctionCallIdsFromInput(seenRequests[0].input)).not.toContain(ORPHAN_RESUME_CALL_ID);
});

it('disableChaining recovery sends a paired full-history Codex request without warmup', async () => {
  const { transport, seenRequests } = createRejectingOrphanCodexTransport();
  const model = createCodexWsModel(transport, 'session-corrupt-recovery');

  await expect(
    collect(
      model.stream({
        previousResponseId: STALE_WARMUP_RESPONSE_ID,
        input: resumedCorruptHistory(),
        tools: [],
      } as any),
    ),
  ).rejects.toThrow(`No tool call found for function call output with call_id ${ORPHAN_RESUME_CALL_ID}.`);

  const events = await collect(
    model.stream({
      previousResponseId: STALE_WARMUP_RESPONSE_ID,
      input: resumedCorruptHistory(),
      tools: [],
      disableChaining: true,
    } as any),
  );

  const recoveryRequests = seenRequests.slice(1);
  expect(recoveryRequests).toHaveLength(1);
  expect(recoveryRequests[0].previousResponseId).toBeUndefined();
  expect(recoveryRequests[0].providerOptions?.generate).not.toBe(false);
  expect(collectFunctionCallIdsFromInput(recoveryRequests[0].input)).toContain(ORPHAN_RESUME_CALL_ID);
  expect(collectToolOutputCallIds(recoveryRequests[0].input)).toContain(ORPHAN_RESUME_CALL_ID);
  expect(events.some((event: any) => event.type === 'completion')).toBe(true);
});

it('identical Codex chain-recovery fingerprints terminate locally without a second invalid request', async () => {
  const { transport, seenRequests } = createRejectingOrphanCodexTransport();
  const model = createCodexWsModel(transport, 'session-no-progress');
  const request = {
    previousResponseId: STALE_WARMUP_RESPONSE_ID,
    input: resumedCorruptHistory(),
    tools: [],
  } as any;

  await expect(collect(model.stream(request))).rejects.toThrow(
    `No tool call found for function call output with call_id ${ORPHAN_RESUME_CALL_ID}.`,
  );
  await expect(collect(model.stream(request))).rejects.toMatchObject({
    name: 'ConversationStateNoProgressError',
  });
  expect(seenRequests).toHaveLength(1);
});

it('CodexResponsesWSModel applies configured websocket receive timeouts', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  vi.useFakeTimers();
  const external = new AbortController();
  let sdkSignal: AbortSignal | undefined;
  transport.fetchResponse = async function (request: any) {
    sdkSignal = request.signal;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
      undefined,
      undefined,
      undefined,
      { firstFrameMs: 25, interFrameMs: 50 },
      transport,
    );
    const pending = collect(
      model.stream({
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
        signal: external.signal,
      } as any),
    );
    void pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(25);
    expect(sdkSignal?.aborted).toBe(true);
    expect(sdkSignal?.reason).toBeInstanceOf(Error);
    expect((sdkSignal?.reason as Error).message).toBe('WebSocket first frame timeout');
  } finally {
    external.abort();
    vi.useRealTimers();
  }
});

// The watchdog is the only component that knows both what it measured and what
// budget it measured against; if that never reaches the traffic log, the guard's
// margin can only be discovered by a live turn dying to a false positive.
it('CodexResponsesWSModel records the watchdog receive timing of a completed websocket response', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordResponseClosed(input) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_timing' } },
      { type: 'response.output_text.delta', delta: 'hi' },
      { type: 'response.completed', response: { id: 'resp_timing', output: [], status: 'completed' } },
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    { firstFrameMs: 90_000, interFrameMs: 600_000 },
    transport,
  );

  await collect(model.stream({ input: [], tools: [] }));

  const received = trafficCalls.find(({ method }) => method === 'recordResponseReceived');
  expect(received?.args.receiveTiming).toMatchObject({
    frameCount: 3,
    firstFrameBudgetMs: 90_000,
    interFrameBudgetMs: 600_000,
  });
  expect(typeof received?.args.receiveTiming.firstFrameMs).toBe('number');
});

it('CodexResponsesWSModel records how long a first-frame timeout waited against its budget', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordResponseClosed(input) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
  };

  vi.useFakeTimers();
  transport.fetchResponse = async function (request: any) {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          }),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      undefined,
      { firstFrameMs: 25, interFrameMs: 50 },
      transport,
    );
    const pending = collect(model.stream({ input: [], tools: [] }));
    void pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).rejects.toThrow('WebSocket first frame timeout');

    const failed = trafficCalls.find(({ method }) => method === 'recordRequestFailed');
    expect(failed?.args.receiveTiming).toEqual({
      frameCount: 0,
      waitedMs: 25,
      firstFrameBudgetMs: 25,
      interFrameBudgetMs: 50,
    });
  } finally {
    vi.useRealTimers();
  }
});

// Phase 2 of ROADMAP.md: a first-frame watchdog timeout is only safe to retry
// when the send path proves the frame never reached the wire. Positive evidence
// unlocks recovery; anything less stays ambiguous and terminates.
it('CodexResponsesWSModel reports a first-frame timeout as provably unsent when the frame never reached an open socket', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  vi.useFakeTimers();
  transport.fetchResponse = async function (request: any) {
    recordWebSocketDispatch(request, 'unsent');
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          }),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
      undefined,
      undefined,
      undefined,
      { firstFrameMs: 25, interFrameMs: 50 },
      transport,
    );
    const pending = collect(model.stream({ input: [], tools: [] } as any));
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(25);
    const error = await pending.catch((reason) => reason);

    expect(error).toBeInstanceOf(UnsentWebSocketRequestError);
    expect(error).not.toBeInstanceOf(AmbiguousModelOutcomeError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe('WebSocket first frame timeout');
  } finally {
    vi.useRealTimers();
  }
});

it('CodexResponsesWSModel keeps a first-frame timeout ambiguous once the frame was flushed to an open socket', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  vi.useFakeTimers();
  transport.fetchResponse = async function (request: any) {
    recordWebSocketDispatch(request, 'flushed');
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          }),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
      undefined,
      undefined,
      undefined,
      { firstFrameMs: 25, interFrameMs: 50 },
      transport,
    );
    const pending = collect(model.stream({ input: [], tools: [] } as any));
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(25);
    const error = await pending.catch((reason) => reason);

    expect(error).toBeInstanceOf(AmbiguousModelOutcomeError);
    expect(error).not.toBeInstanceOf(UnsentWebSocketRequestError);
  } finally {
    vi.useRealTimers();
  }
});

// Fail-closed: a send path that recorded nothing is not evidence of anything.
it('CodexResponsesWSModel keeps a first-frame timeout ambiguous when the send path observed nothing', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  vi.useFakeTimers();
  transport.fetchResponse = async function (request: any) {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          }),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
      undefined,
      undefined,
      undefined,
      { firstFrameMs: 25, interFrameMs: 50 },
      transport,
    );
    const pending = collect(model.stream({ input: [], tools: [] } as any));
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(25);
    const error = await pending.catch((reason) => reason);

    expect(error).toBeInstanceOf(AmbiguousModelOutcomeError);
  } finally {
    vi.useRealTimers();
  }
});

// An idle timeout mid-stream cannot be unsent: frames already arrived.
it('CodexResponsesWSModel keeps an idle timeout ambiguous even if a stale unsent record survives', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  vi.useFakeTimers();
  transport.fetchResponse = async function (request: any) {
    recordWebSocketDispatch(request, 'unsent');
    let reads = 0;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve({ done: false, value: { type: 'response.created' } });
          return new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          });
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
      undefined,
      undefined,
      undefined,
      { firstFrameMs: 25, interFrameMs: 50 },
      transport,
    );
    const pending = collect(model.stream({ input: [], tools: [] } as any));
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(75);
    const error = await pending.catch((reason) => reason);

    expect(error).not.toBeInstanceOf(UnsentWebSocketRequestError);
  } finally {
    vi.useRealTimers();
  }
});

it('CodexResponsesTransport and OpenAIResponsesModel support close() without error', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', true);
  transport.close();
  const model = new OpenAIResponsesModel({} as any, 'gpt-5-codex', transport, true);
  await model.close();
});
