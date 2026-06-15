import test from 'ava';
import { withTrace } from '@openai/agents-core';
import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';
import { CodexResponsesModel, CodexResponsesWSModel, wrapCodexStream } from './codex-responses-model.js';

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

test('wrapCodexStream reconstructs response.completed.output from streamed output_item.done items', async (t) => {
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
  t.truthy(completed);
  t.is(completed.response.output.length, 1);
  t.is(completed.response.output[0], item);
});

test('wrapCodexStream reconstructs missing terminal response.output from streamed output_item.done items', async (t) => {
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
  t.truthy(completed);
  t.deepEqual(completed.response.output, [item]);
});

test('wrapCodexStream reconstructs missing output for non-completed terminal frames', async (t) => {
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
  t.truthy(incomplete);
  t.deepEqual(incomplete.response.output, [item]);
});

test('wrapCodexStream leaves non-empty output untouched', async (t) => {
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
  t.is(completed.response.output.length, 1);
  t.is(completed.response.output[0], serverItem);
});

test('wrapCodexStream reconstructs each completed response from only its own streamed items', async (t) => {
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
  t.is(completed.length, 2);
  t.deepEqual(completed[0].response.output, [firstItem]);
  t.deepEqual(completed[1].response.output, [secondItem]);
});

test('wrapCodexStream keeps empty output empty when no items were streamed', async (t) => {
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
  t.is(completed.response.output.length, 0);
});

test('wrapCodexStream backfills function_call call_id from function_call_arguments.done event', async (t) => {
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
  t.truthy(completed);
  t.is(completed.response.output.length, 1);
  t.is(
    completed.response.output[0].call_id,
    expectedCallId,
    'call_id should be backfilled from function_call_arguments.done',
  );
  t.is(completed.response.output[0].id, 'fc_backfill');
});

test('wrapCodexStream survives a frozen response object by cloning', async (t) => {
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
  t.is(completed.response.output.length, 1);
  t.is(completed.response.output[0], item);
});

test('wrapCodexStream warns with metadata when reconstructed output is suspiciously large', async (t) => {
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
  t.is(completed.response.output.length, 21);
  t.is(warnings.length, 1);
  t.is(warnings[0].eventType, 'codex.reconstructed_output.suspicious');
  t.is(warnings[0].responseId, 'resp_large');
  t.is(warnings[0].itemCount, 21);
  t.is(warnings[0].firstItemId, 'item_0');
  t.is(warnings[0].lastItemId, 'item_20');
  t.false('output' in warnings[0]);
});

// Integration check: confirm CodexResponsesModel.getStreamedResponse threads
// the stream through wrapCodexStream so a Codex-style terminal frame with
// empty output gets rebuilt into a populated response_done event. We stub the
// parent's `_fetchResponse` on the prototype so our subclass override (which
// delegates to super) sees a controlled stream without needing a real OpenAI
// client.
test.serial('CodexResponsesModel.getStreamedResponse yields response_done with reconstructed output', async (t) => {
  const original = (OpenAIResponsesModel.prototype as any)._fetchResponse;
  (OpenAIResponsesModel.prototype as any)._fetchResponse = async function () {
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
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex');
    const request: any = { input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] };
    const events = await collect(model.getStreamedResponse(request));

    const done = events.find((e: any) => e.type === 'response_done') as any;
    t.truthy(done, 'expected a response_done event');
    t.is(done.response.output.length, 1);
    t.is(done.response.output[0].type, 'message');
    t.is(done.response.output[0].id, 'msg_1');
    t.is(done.response.output[0].role, 'assistant');
  } finally {
    (OpenAIResponsesModel.prototype as any)._fetchResponse = original;
  }
});

test.serial('CodexResponsesModel.getStreamedResponse tolerates missing terminal response.output', async (t) => {
  const original = (OpenAIResponsesModel.prototype as any)._fetchResponse;
  (OpenAIResponsesModel.prototype as any)._fetchResponse = async function () {
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
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex');
    const request: any = { input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] };
    const events = await collect(model.getStreamedResponse(request));

    const done = events.find((e: any) => e.type === 'response_done') as any;
    t.truthy(done, 'expected a response_done event');
    t.is(done.response.output.length, 1);
    t.is(done.response.output[0].id, 'msg_missing_output');
  } finally {
    (OpenAIResponsesModel.prototype as any)._fetchResponse = original;
  }
});

test.serial(
  'CodexResponsesModel._buildResponsesCreateRequest merges modelSettings.include into requestData.include',
  (t) => {
    const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
      return {
        requestData: {
          include: ['file_search_call.results'],
        },
        sdkRequestHeaders: {},
        signal: undefined,
      };
    };

    try {
      const model = new CodexResponsesModel({} as any, 'gpt-5-codex');
      const built = (model as any)._buildResponsesCreateRequest(
        {
          modelSettings: {
            include: ['reasoning.encrypted_content', 'file_search_call.results'],
          },
        },
        true,
      );

      t.deepEqual(built.requestData.include, ['file_search_call.results', 'reasoning.encrypted_content']);
    } finally {
      (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
    }
  },
);

test.serial('CodexResponsesModel._buildResponsesCreateRequest strips temperature from requestData', (t) => {
  const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
    return {
      requestData: {
        temperature: 0.2,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex');
    const built = (model as any)._buildResponsesCreateRequest({ modelSettings: { temperature: 0.2 } }, true);

    t.false('temperature' in built.requestData);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

test.serial('CodexResponsesModel._buildResponsesCreateRequest forwards prompt_cache_key from modelSettings', (t) => {
  const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
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
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex');
    const built = (model as any)._buildResponsesCreateRequest(
      {
        modelSettings: {
          prompt_cache_key: 'conv_123',
        },
      },
      true,
    );

    t.is(built.requestData.prompt_cache_key, 'conv_123');
    t.false('temperature' in built.requestData);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

test.serial('CodexResponsesModel._buildResponsesCreateRequest strips replay item ids from input', (t) => {
  const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
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
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex');
    const built = (model as any)._buildResponsesCreateRequest({ modelSettings: {} }, true);

    t.false('id' in built.requestData.input[0]);
    t.false('id' in built.requestData.input[1]);
    t.false('id' in built.requestData.input[2]);
    t.is(built.requestData.input[2].call_id, 'call_1');
    t.false('id' in built.requestData.input[3]);
    t.is(built.requestData.input[4].id, 'ig_1');
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

test('CodexResponsesWSModel extends OpenAIResponsesWSModel', (t) => {
  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  const model = new CodexResponsesWSModel(mockClient as any, 'gpt-5-codex', tokenManager as any);

  t.true(model instanceof OpenAIResponsesWSModel);
});

test.serial('CodexResponsesWSModel emits traffic logs for websocket streamed responses', async (t) => {
  const original = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  const logs: Array<{ level: string; message: string; meta?: any }> = [];

  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function () {
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

  const loggingService = {
    debug: (message: string, meta?: any) => logs.push({ level: 'debug', message, meta }),
    error: (message: string, meta?: any) => logs.push({ level: 'error', message, meta }),
    getCorrelationId: () => 'trace-log-1',
  };
  const sessionContextService = {
    getContext: () => ({
      sessionId: 'sess_ws_1',
      sessionStartedAt: '2025-01-01T00:00:00.000Z',
      firstUserMessagePreview: 'hello ws',
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
      loggingService as any,
      sessionContextService as any,
    );
    const request: any = { input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] };

    const events = await collect(model.getStreamedResponse(request));

    t.is((events[events.length - 1] as any).event?.type, 'response.completed');
    t.is(logs.length, 2);
    t.is(logs[0].meta.eventType, 'provider.request.started');
    t.is(logs[1].meta.eventType, 'provider.response.received');
    t.is(logs[0].meta.requestId, logs[1].meta.requestId);
    t.is(logs[0].meta.sessionId, 'sess_ws_1');
    t.is(logs[0].meta.headers.authorization, '[REDACTED]');
    t.is(logs[1].meta.payload.transport, 'websocket');
    t.is(logs[1].meta.payload.responseId, 'resp_ws_traffic');
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = original;
  }
});

test.serial(
  'CodexResponsesWSModel logs reasoning and tool calls in choice payload matching HTTP/SSE logs',
  async (t) => {
    const logs: any[] = [];
    const original = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;

    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function () {
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
            call_id: 'fc_123',
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

    const loggingService = {
      debug: (message: string, meta?: any) => logs.push({ level: 'debug', message, meta }),
      error: (message: string, meta?: any) => logs.push({ level: 'error', message, meta }),
      getCorrelationId: () => 'trace-log-2',
    };
    const sessionContextService = {
      getContext: () => ({
        sessionId: 'sess_ws_2',
        sessionStartedAt: '2025-01-01T00:00:00.000Z',
        firstUserMessagePreview: 'hello ws 2',
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
        loggingService as any,
        sessionContextService as any,
      );
      const request: any = { input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] };

      await collect(model.getStreamedResponse(request));

      t.is(logs.length, 2);
      const receivedPayload = logs[1].meta.payload;
      t.is(receivedPayload.transport, 'websocket');
      t.is(receivedPayload.responseId, 'resp_ws_reasoning_tool');
      t.deepEqual(receivedPayload.outputTypes, ['reasoning', 'function_call']);

      // Check unified payload matching HTTP/SSE structure
      t.truthy(receivedPayload.payload);
      t.is(receivedPayload.payload.id, 'resp_ws_reasoning_tool');
      t.deepEqual(receivedPayload.payload.usage, { input_tokens: 5, output_tokens: 6, total_tokens: 11 });
      t.is(receivedPayload.payload.choices.length, 1);

      const delta = receivedPayload.payload.choices[0].delta;
      t.is(delta.reasoning, 'Let me think about this request.');
      t.deepEqual(delta.tool_calls, [
        {
          id: 'fc_123',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"ls"}',
          },
        },
      ]);
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = original;
    }
  },
);

test.serial('CodexResponsesModel.getResponse (unary) intercepts and runs as stream under the hood', async (t) => {
  const original = (OpenAIResponsesModel.prototype as any)._fetchResponse;
  let receivedStreamArg = false;

  (OpenAIResponsesModel.prototype as any)._fetchResponse = async function (_request: any, stream: boolean) {
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
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex');
    const request: any = { input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] };

    // Call getResponse which defaults to stream: false
    const response = await withTrace('test', () => model.getResponse(request));

    t.true(receivedStreamArg, 'should have forced stream: true internally');
    t.is(response.responseId, 'resp_unary');
    t.is(response.output.length, 1);
    t.is(response.output[0].id, 'msg_unary');
    t.is(response.usage.totalTokens, 5);
  } finally {
    (OpenAIResponsesModel.prototype as any)._fetchResponse = original;
  }
});

test.serial('CodexResponsesWSModel.getResponse (unary) intercepts and runs as stream under the hood', async (t) => {
  const original = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  let receivedStreamArg = false;

  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (_request: any, stream: boolean) {
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
    const model = new CodexResponsesWSModel(mockClient as any, 'gpt-5-codex', tokenManager as any);
    const request: any = { input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] };

    // Call getResponse which defaults to stream: false
    const response = await model.getResponse(request);

    t.true(receivedStreamArg, 'should have forced stream: true internally');
    t.is(response.responseId, 'resp_ws_unary');
    t.is(response.output.length, 1);
    t.is(response.output[0].id, 'msg_ws_unary');
    t.is(response.usage.totalTokens, 7);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = original;
  }
});

test('wrapCodexStream throws a detailed stream error when receiving response.error event', async (t) => {
  const errorObj = { message: 'Some specific API error description' };
  const eventStream = wrapCodexStream(makeStream([{ type: 'response.error', error: errorObj }]));

  const error = await t.throwsAsync(async () => {
    for await (const _ of eventStream) {
    }
  });

  t.true(error instanceof Error);
  t.is(error.message, 'Codex provider stream error: Some specific API error description');
});

test('wrapCodexStream throws when receiving response.error event without error field', async (t) => {
  const eventStream = wrapCodexStream(makeStream([{ type: 'response.error' }]));

  const error = await t.throwsAsync(async () => {
    for await (const _ of eventStream) {
    }
  });

  t.true(error instanceof Error);
  t.true(error.message.startsWith('Codex provider stream error:'));
});

test('wrapCodexStream throws a detailed provider error when receiving a failed response status', async (t) => {
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

  const error = await t.throwsAsync(async () => {
    for await (const _ of eventStream) {
    }
  });

  t.true(error instanceof Error);
  t.is(error.message, 'Codex provider error: Model context length exceeded');
});

function createSleepRecorder() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (delayMs: number) => {
      delays.push(delayMs);
    },
  };
}

const DEFAULT_STREAM_MAX_RETRIES = 5;

test.serial(
  'CodexResponsesWSModel injects Codex previous response id and trims replayed tool-continuation input',
  async (t) => {
    const seenRequests: any[] = [];
    const toolOutput = {
      type: 'function_call_result',
      callId: 'call-read',
      output: 'done',
    };

    const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
      );

      for await (const _event of model.getStreamedResponse({
        input: [{ role: 'user', type: 'message', content: 'inspect' }],
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any)) {
      }

      t.is(seenRequests.length, 2);
      t.is(seenRequests[0].modelSettings.providerData?.generate, false);
      t.deepEqual(seenRequests[0].input, []);
      t.is(seenRequests[1].previousResponseId, 'resp-1');
      t.deepEqual(seenRequests[1].input, [{ role: 'user', type: 'message', content: 'inspect' }]);

      for await (const _event of model.getStreamedResponse({
        input: [
          { role: 'user', type: 'message', content: 'inspect' },
          { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
          { type: 'function_call', call_id: 'call-read', name: 'read_file', arguments: '{}' },
          toolOutput,
        ],
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any)) {
      }

      t.is(seenRequests.length, 3);
      t.is(seenRequests[2].previousResponseId, 'resp-2');
      t.deepEqual(seenRequests[2].input, [toolOutput]);

      const latestUser = { role: 'user', type: 'message', content: 'summarize' };
      for await (const _event of model.getStreamedResponse({
        previousResponseId: 'resp-explicit',
        input: [
          { role: 'user', type: 'message', content: 'inspect' },
          { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
          latestUser,
        ],
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any)) {
      }

      t.is(seenRequests.length, 4);
      t.is(seenRequests[3].previousResponseId, 'resp-explicit');
      t.deepEqual(seenRequests[3].input, [latestUser]);
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
    }
  },
);

test.serial(
  'CodexResponsesWSModel retries safe Codex warm-up failures before chaining the delta request',
  async (t) => {
    const seenRequests: any[] = [];
    const sleep = createSleepRecorder();
    const safeWarmupError = Object.assign(new Error('Responses websocket connection closed before opening.'), {
      code: 'connection_closed_before_opening',
    });

    const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        throw safeWarmupError;
      }
      return makeStream([
        {
          type: 'response.completed',
          response: {
            id: seenRequests.length === 2 ? 'resp-warmup' : 'resp-main',
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
        { sleep: sleep.sleep },
      );

      (model as any).getRetryAdvice = async ({ error }: any) =>
        error === safeWarmupError ? { suggested: true, replaySafety: 'safe' } : { suggested: false };

      const latestUser = { role: 'user', type: 'message', content: 'next' };
      await model.getResponse({
        input: [
          { role: 'user', type: 'message', content: 'first' },
          { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first response' }] },
          latestUser,
        ],
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any);

      t.is(seenRequests.length, 3);
      t.is(sleep.delays.length, 1);
      t.true(sleep.delays[0] > 0);
      t.is(seenRequests[0].modelSettings.providerData?.generate, false);
      t.is(seenRequests[1].modelSettings.providerData?.generate, false);
      t.deepEqual(seenRequests[0].input, seenRequests[1].input);
      t.is(seenRequests[2].previousResponseId, 'resp-warmup');
      t.deepEqual(seenRequests[2].input, [latestUser]);
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
    }
  },
);

test.serial(
  'CodexResponsesWSModel falls back to full history without previous response id when safe Codex warm-up retries are exhausted',
  async (t) => {
    const seenRequests: any[] = [];
    const sleep = createSleepRecorder();
    const safeWarmupError = Object.assign(new Error('Responses websocket connection closed before opening.'), {
      code: 'connection_closed_before_opening',
    });

    const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
      seenRequests.push(request);
      if (seenRequests.length <= DEFAULT_STREAM_MAX_RETRIES + 1) {
        throw safeWarmupError;
      }
      return makeStream([
        {
          type: 'response.completed',
          response: {
            id: 'resp-main',
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
        { sleep: sleep.sleep },
      );

      (model as any).getRetryAdvice = async ({ error }: any) =>
        error === safeWarmupError ? { suggested: true, replaySafety: 'safe' } : { suggested: false };

      const fullInput = [
        { role: 'user', type: 'message', content: 'first' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first response' }] },
        { role: 'user', type: 'message', content: 'next' },
      ];
      for await (const _event of model.getStreamedResponse({
        input: fullInput,
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any)) {
      }

      const expectedTotalAttempts = DEFAULT_STREAM_MAX_RETRIES + 2;
      t.is(seenRequests.length, expectedTotalAttempts);
      t.is(sleep.delays.length, DEFAULT_STREAM_MAX_RETRIES);
      t.true(sleep.delays.every((delayMs) => delayMs > 0));
      t.true(
        seenRequests
          .slice(0, expectedTotalAttempts - 1)
          .every((request) => request.modelSettings.providerData?.generate === false),
      );
      t.deepEqual(seenRequests[expectedTotalAttempts - 1].input, fullInput);
      t.is(seenRequests[expectedTotalAttempts - 1].previousResponseId, undefined);
      t.is(seenRequests[expectedTotalAttempts - 1].modelSettings.providerData?.generate, undefined);
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
    }
  },
);
