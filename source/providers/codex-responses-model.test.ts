import test from 'ava';
import { OpenAIResponsesModel } from '@openai/agents-openai';
import { CodexResponsesModel, wrapCodexStream } from './codex-responses-model.js';

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
