import test from 'ava';
import { withTrace } from '@openai/agents-core';
import { OpenAIResponsesModel } from '@openai/agents-openai';
import { CodexResponsesModel, CodexResponsesWSModel, wrapCodexStream } from './codex-responses-model.js';
import { TimedResponsesWSModel } from './timed-responses-ws-model.js';
import { DEFAULT_TIMED_WS_TIMEOUTS } from './timed-ws-timeouts.js';

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

test('CodexResponsesWSModel extends TimedResponsesWSModel and configures timeouts', (t) => {
  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  const model = new CodexResponsesWSModel(mockClient as any, 'gpt-5-codex', tokenManager as any, undefined, {
    connectTimeoutMs: 1000,
    idleTimeoutMs: 5000,
  });

  t.deepEqual((model as any).options, { connectTimeoutMs: 1000, idleTimeoutMs: 5000 });
});

test('CodexResponsesWSModel uses default timeouts when none are passed', (t) => {
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

  t.deepEqual((model as any).options, {
    ...DEFAULT_TIMED_WS_TIMEOUTS,
  });
});

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
  const original = (TimedResponsesWSModel.prototype as any)._fetchResponse;
  let receivedStreamArg = false;

  (TimedResponsesWSModel.prototype as any)._fetchResponse = async function (_request: any, stream: boolean) {
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
    (TimedResponsesWSModel.prototype as any)._fetchResponse = original;
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
