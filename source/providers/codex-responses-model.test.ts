import { it, expect } from 'vitest';
import { withTrace } from '@openai/agents-core';
import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';
import type { IProviderTraffic } from '../services/service-interfaces.js';
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

// Integration check: confirm CodexResponsesModel.getStreamedResponse threads
// the stream through wrapCodexStream so a Codex-style terminal frame with
// empty output gets rebuilt into a populated response_done event. We stub the
// parent's `_fetchResponse` on the prototype so our subclass override (which
// delegates to super) sees a controlled stream without needing a real OpenAI
// client.
it.sequential('CodexResponsesModel.getStreamedResponse yields response_done with reconstructed output', async () => {
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
    expect(done).toBeTruthy();
    expect(done.response.output.length).toBe(1);
    expect(done.response.output[0].type).toBe('message');
    expect(done.response.output[0].id).toBe('msg_1');
    expect(done.response.output[0].role).toBe('assistant');
  } finally {
    (OpenAIResponsesModel.prototype as any)._fetchResponse = original;
  }
});

it.sequential('CodexResponsesModel.getStreamedResponse tolerates missing terminal response.output', async () => {
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
    expect(done).toBeTruthy();
    expect(done.response.output.length).toBe(1);
    expect(done.response.output[0].id).toBe('msg_missing_output');
  } finally {
    (OpenAIResponsesModel.prototype as any)._fetchResponse = original;
  }
});

it.sequential(
  'CodexResponsesModel._buildResponsesCreateRequest merges modelSettings.include into requestData.include',
  () => {
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

      expect(built.requestData.include).toEqual(['file_search_call.results', 'reasoning.encrypted_content']);
    } finally {
      (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
    }
  },
);

it.sequential('CodexResponsesModel._buildResponsesCreateRequest strips temperature from requestData', () => {
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

    expect('temperature' in built.requestData).toBe(false);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it.sequential('CodexResponsesModel._buildResponsesCreateRequest forwards prompt_cache_key from modelSettings', () => {
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

    expect(built.requestData.prompt_cache_key).toBe('conv_123');
    expect('temperature' in built.requestData).toBe(false);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it.sequential('CodexResponsesModel sends gpt-5.6-luna through the Responses Lite protocol', () => {
  const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
    return {
      requestData: {
        instructions: 'Follow the repository instructions.',
        input: [{ role: 'user', type: 'message', content: 'Review this change.' }],
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
        parallel_tool_calls: true,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5.6-luna');
    const built = (model as any)._buildResponsesCreateRequest({ modelSettings: {} }, true);

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
      { role: 'user', type: 'message', content: 'Review this change.' },
    ]);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it.sequential('CodexResponsesModel does not resend Luna developer instructions on chained requests', () => {
  const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
    return {
      requestData: {
        previous_response_id: 'resp_previous',
        instructions: 'Follow the repository instructions.',
        input: [{ role: 'user', type: 'message', content: 'Continue the review.' }],
        tools: [],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5.6-luna');
    const built = (model as any)._buildResponsesCreateRequest({ modelSettings: {} }, true);

    expect(built.requestData.input).toEqual([
      { type: 'additional_tools', role: 'developer', tools: [] },
      { role: 'user', type: 'message', content: 'Continue the review.' },
    ]);
    expect(built.requestData.instructions).toBe('');
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it.sequential('CodexResponsesModel._buildResponsesCreateRequest strips replay item ids from input', () => {
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

    expect('id' in built.requestData.input[0]).toBe(false);
    expect('id' in built.requestData.input[1]).toBe(false);
    expect('id' in built.requestData.input[2]).toBe(false);
    expect(built.requestData.input[2].call_id).toBe('call_1');
    expect('id' in built.requestData.input[3]).toBe(false);
    expect(built.requestData.input[4].id).toBe('ig_1');
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it.sequential(
  'CodexResponsesModel._buildResponsesCreateRequest drops unpaired function calls for stateless fallback',
  () => {
    const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
      return {
        requestData: {
          input: [
            { role: 'user', type: 'message', content: 'continue' },
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
      const model = new CodexResponsesModel({} as any, 'gpt-5-codex');
      const built = (model as any)._buildResponsesCreateRequest({ modelSettings: {} }, true);

      expect(built.requestData.previous_response_id).toBeUndefined();
      expect(built.requestData.input.map((item: any) => item.call_id).filter(Boolean)).toEqual([
        'call-paired',
        'call-paired',
      ]);
    } finally {
      (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
    }
  },
);

it.sequential('CodexResponsesModel._buildResponsesCreateRequest keeps function calls for chained requests', () => {
  const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
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
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex');
    const built = (model as any)._buildResponsesCreateRequest({ modelSettings: {} }, true);

    expect(built.requestData.input).toEqual([
      { type: 'function_call', call_id: 'call-server-held', name: 'shell', arguments: '{}' },
    ]);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it('CodexResponsesWSModel extends OpenAIResponsesWSModel', () => {
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

  expect(model instanceof OpenAIResponsesWSModel).toBe(true);
});

it.sequential('CodexResponsesWSModel emits traffic logs for websocket streamed responses', async () => {
  const original = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
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
  };

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
    );
    const request: any = { input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] };

    const events = await collect(model.getStreamedResponse(request));

    expect((events[events.length - 1] as any).event?.type).toBe('response.completed');
    expect(trafficCalls.length).toBe(2);
    expect(trafficCalls[0].method).toBe('recordRequestStart');
    expect(trafficCalls[1].method).toBe('recordResponseReceived');
    expect(trafficCalls[0].args.requestId).toBe(trafficCalls[1].args.requestId);
    expect(trafficCalls[0].args.sessionId).toBeUndefined(); // Codex model doesn't pass sessionId directly
    expect(trafficCalls[0].args.headers.authorization).toBe('[REDACTED]');
    expect(trafficCalls[1].args.transport).toBe('websocket');
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = original;
  }
});

it.sequential('CodexResponsesWSModel sends only new input after a Responses-Lite prefix is established', async () => {
  const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  const trafficBodies: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordRequestFailed() {},
  };

  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function () {
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
    );

    const tool = { type: 'function', name: 'shell', parameters: { type: 'object' } };
    const firstUserMessage = { role: 'user', type: 'message', content: 'hello' };
    const secondUserMessage = { role: 'user', type: 'message', content: 'how are you?' };

    await collect(
      model.getStreamedResponse({
        input: [firstUserMessage],
        systemInstructions: 'Follow the repository instructions.',
        modelSettings: {},
        tools: [tool],
        handoffs: [],
      } as any),
    );
    await collect(
      model.getStreamedResponse({
        previousResponseId: 'resp_lite_2',
        input: [secondUserMessage],
        systemInstructions: 'Follow the repository instructions.',
        modelSettings: {},
        tools: [tool],
        handoffs: [],
      } as any),
    );

    expect(trafficBodies).toHaveLength(3);
    expect(trafficBodies[0].input[0]).toMatchObject({ type: 'additional_tools', role: 'developer' });
    expect(trafficBodies[1].previous_response_id).toBe('resp_lite_1');
    expect(trafficBodies[1].input).toEqual([expect.objectContaining({ role: 'user', content: 'hello' })]);
    expect(trafficBodies[2].previous_response_id).toBe('resp_lite_2');
    expect(trafficBodies[2].input).toEqual([expect.objectContaining({ role: 'user', content: 'how are you?' })]);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
  }
});

it.sequential('CodexResponsesWSModel correlates Responses-Lite state across sequential streamed requests', async () => {
  const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  const trafficBodies: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordRequestFailed() {},
  };

  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function () {
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
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-token', traceId: 'trace-token' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
    );

    const tool = { type: 'function', name: 'shell', parameters: { type: 'object' } };
    const msg1 = { role: 'user', type: 'message', content: 'first' };
    const msg2 = { role: 'user', type: 'message', content: 'second' };

    // First turn establishes the stored baseline.
    await collect(
      model.getStreamedResponse({
        input: [msg1],
        systemInstructions: 'Do it.',
        modelSettings: {},
        tools: [tool],
        handoffs: [],
      } as any),
    );

    // Second turn chains off the first.
    await collect(
      model.getStreamedResponse({
        previousResponseId: 'resp_token_2',
        input: [msg2],
        systemInstructions: 'Do it.',
        modelSettings: {},
        tools: [tool],
        handoffs: [],
      } as any),
    );

    // Traffic captures tell us the delta is correctly computed across turns.
    expect(trafficBodies).toHaveLength(3);
    // The third body (second turn's final request) should carry just the
    // new user message as a delta.
    expect(trafficBodies[2].previous_response_id).toBe('resp_token_2');
    expect(trafficBodies[2].input).toEqual([expect.objectContaining({ role: 'user', content: 'second' })]);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
  }
});

it.sequential('CodexResponsesWSModel does not use wire state for non-Luna models', async () => {
  const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function () {
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
    );

    // Verify no tokens are stored for non-Luna requests.
    const built = (model as any)._buildResponsesCreateRequest(
      { input: [{ role: 'user', content: 'hello' }], modelSettings: {}, tools: [], handoffs: [] },
      true,
    );

    // requestTokens WeakMap should not have an entry for the request.
    // The built requestData should not have been modified by wire state prep.
    expect(built.requestData.input).toEqual([{ role: 'user', content: 'hello' }]);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
  }
});

it.sequential('CodexResponsesWSModel marks Luna websocket requests as Responses Lite', async () => {
  const original = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  let seenRequest: any;
  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
    seenRequest = request;
    return makeStream([{ type: 'response.completed', response: { id: 'resp_luna', output: [], usage: {} } }]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    );

    await collect(model.getStreamedResponse({ input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] }));

    expect(seenRequest.modelSettings.providerData.extraHeaders['x-openai-internal-codex-responses-lite']).toBe('true');
    expect(seenRequest.modelSettings.providerData.client_metadata).toEqual({
      ws_request_header_x_openai_internal_codex_responses_lite: 'true',
    });
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = original;
  }
});

it.sequential('CodexResponsesWSModel sends Codex turn identity metadata for Luna', async () => {
  const original = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  let seenRequest: any;
  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
    );

    await collect(model.getStreamedResponse({ input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] }));

    const providerData = seenRequest.modelSettings.providerData;
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
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = original;
  }
});

it.sequential('CodexResponsesWSModel keeps turn identity stable across response continuations', async () => {
  const original = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  const seenRequests: any[] = [];
  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
    );

    await collect(model.getStreamedResponse({ input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] }));
    await collect(
      model.getStreamedResponse({
        input: [],
        previousResponseId: 'resp_stable_identity',
        tracing: false,
        modelSettings: {},
        tools: [],
        handoffs: [],
      }),
    );

    expect(seenRequests).toHaveLength(2);
    const firstMetadata = seenRequests[0].modelSettings.providerData.client_metadata;
    const secondMetadata = seenRequests[1].modelSettings.providerData.client_metadata;
    expect(JSON.parse(firstMetadata['x-codex-turn-metadata']).turn_id).toBe(
      JSON.parse(secondMetadata['x-codex-turn-metadata']).turn_id,
    );
    expect(seenRequests[0].modelSettings.providerData.extraHeaders['x-codex-turn-metadata']).toBe(
      seenRequests[1].modelSettings.providerData.extraHeaders['x-codex-turn-metadata'],
    );
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = original;
  }
});

it.sequential(
  'CodexResponsesWSModel logs reasoning and tool calls in choice payload matching HTTP/SSE logs',
  async () => {
    const trafficCalls: Array<{ method: string; args: any }> = [];
    const original = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;

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
    };

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
      );
      const request: any = { input: [], tracing: false, modelSettings: {}, tools: [], handoffs: [] };

      await collect(model.getStreamedResponse(request));

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
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = original;
    }
  },
);

it.sequential('CodexResponsesModel.getResponse (unary) intercepts and runs as stream under the hood', async () => {
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

    expect(receivedStreamArg).toBe(true);
    expect(response.responseId).toBe('resp_unary');
    expect(response.output.length).toBe(1);
    expect(response.output[0].id).toBe('msg_unary');
    expect(response.usage.totalTokens).toBe(5);
  } finally {
    (OpenAIResponsesModel.prototype as any)._fetchResponse = original;
  }
});

it.sequential('CodexResponsesWSModel.getResponse (unary) intercepts and runs as stream under the hood', async () => {
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

    expect(receivedStreamArg).toBe(true);
    expect(response.responseId).toBe('resp_ws_unary');
    expect(response.output.length).toBe(1);
    expect(response.output[0].id).toBe('msg_ws_unary');
    expect(response.usage.totalTokens).toBe(7);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = original;
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

it.sequential(
  'CodexResponsesWSModel injects Codex previous response id and trims replayed tool-continuation input',
  async () => {
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

      expect(seenRequests.length).toBe(2);
      expect(seenRequests[0].modelSettings.providerData?.generate).toBe(false);
      expect(seenRequests[0].input).toEqual([]);
      expect(seenRequests[1].previousResponseId).toBe('resp-1');
      expect(seenRequests[1].input).toEqual([{ role: 'user', type: 'message', content: 'inspect' }]);

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

      expect(seenRequests.length).toBe(3);
      expect(seenRequests[2].previousResponseId).toBe('resp-2');
      expect(seenRequests[2].input).toEqual([toolOutput]);

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

      expect(seenRequests.length).toBe(4);
      expect(seenRequests[3].previousResponseId).toBe('resp-explicit');
      expect(seenRequests[3].input).toEqual([latestUser]);
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
    }
  },
);

it.sequential(
  'CodexResponsesWSModel keeps every interleaved parallel tool output when trimming a tool-continuation delta',
  async () => {
    const seenRequests: any[] = [];

    const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
      output: { type: 'function_call_result', callId: `call-read-${n}`, output: `outline-${n}` },
    }));
    const shellPair = {
      call: { type: 'function_call', call_id: 'call-shell', name: 'shell', arguments: '{}' },
      output: { type: 'function_call_result', callId: 'call-shell', output: 'grep result' },
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
        previousResponseId: 'resp-prev',
        input: [
          { role: 'user', type: 'message', content: 'inspect the repo' },
          { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
          ...parallelReads.flatMap((pair) => [pair.call, pair.output]),
          shellPair.call,
          shellPair.output,
        ],
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any)) {
      }

      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0].previousResponseId).toBe('resp-prev');
      expect(seenRequests[0].input).toEqual([...parallelReads.map((pair) => pair.output), shellPair.output]);
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
    }
  },
);

it.sequential('CodexResponsesWSModel drops tool outputs already consumed by the previous response', async () => {
  const seenRequests: any[] = [];

  const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
    type: 'function_call_result',
    callId: `call-already-sent-${n}`,
    output: `old-${n}`,
  }));
  const nextOutput = {
    type: 'function_call_result',
    callId: 'call-current',
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
    );

    for await (const _event of model.getStreamedResponse({
      previousResponseId: 'resp-tool-calls-1',
      input: firstBatch,
      modelSettings: {},
      tools: [],
      handoffs: [],
    } as any)) {
    }

    for await (const _event of model.getStreamedResponse({
      previousResponseId: 'resp-after-first-batch',
      input: [...firstBatch, nextOutput],
      modelSettings: {},
      tools: [],
      handoffs: [],
    } as any)) {
    }

    for await (const _event of model.getStreamedResponse({
      previousResponseId: 'resp-after-second-batch',
      input: [nextOutput],
      modelSettings: {},
      tools: [],
      handoffs: [],
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
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
  }
});

it.sequential(
  'CodexResponsesWSModel drops interleaved tool calls from an already-trimmed tool-continuation delta',
  async () => {
    const seenRequests: any[] = [];

    const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
      output: { type: 'function_call_result', callId: `call-${n}`, output: `outline-${n}` },
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
      );

      for await (const _event of model.getStreamedResponse({
        previousResponseId: 'resp-prev',
        input: pairs.flatMap((pair) => [pair.call, pair.output]),
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any)) {
      }

      expect(seenRequests.length).toBe(1);
      expect(seenRequests[0].previousResponseId).toBe('resp-prev');
      expect(seenRequests[0].input).toEqual(pairs.map((pair) => pair.output));
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
    }
  },
);

it.sequential('CodexResponsesWSModel keeps interleaved outputs when function calls only carry item ids', async () => {
  const seenRequests: any[] = [];

  const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
    output: { type: 'function_call_result', callId: `call-${n}`, output: `result-${n}` },
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
    );

    for await (const _event of model.getStreamedResponse({
      previousResponseId: 'resp-prev',
      input: pairs.flatMap((pair) => [pair.call, pair.output]),
      modelSettings: {},
      tools: [],
      handoffs: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-prev');
    expect(seenRequests[0].input).toEqual(pairs.map((pair) => pair.output));
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
  }
});

it.sequential(
  'CodexResponsesWSModel warms interleaved tool continuations into history before sending the delta',
  async () => {
    const seenRequests: any[] = [];

    const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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

    const openingUser = { role: 'user', type: 'message', content: 'inspect the repo' };
    const openingAssistant = {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'I will inspect it.' }],
    };
    const parallelReads = [1, 2].map((n) => ({
      call: { type: 'function_call', call_id: `call-read-${n}`, name: 'read_code_outline', arguments: '{}' },
      output: { type: 'function_call_result', callId: `call-read-${n}`, output: `outline-${n}` },
    }));
    const shellPair = {
      call: { type: 'function_call', call_id: 'call-shell', name: 'shell', arguments: '{}' },
      output: { type: 'function_call_result', callId: 'call-shell', output: 'grep result' },
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
        input: [
          openingUser,
          openingAssistant,
          ...parallelReads.flatMap((pair) => [pair.call, pair.output]),
          shellPair.call,
          shellPair.output,
        ],
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any)) {
      }

      expect(seenRequests.length).toBe(2);
      expect(seenRequests[0].modelSettings.providerData?.generate).toBe(false);
      expect(seenRequests[0].previousResponseId).toBe(undefined);
      expect(seenRequests[0].input).toEqual([
        openingUser,
        openingAssistant,
        ...parallelReads.map((pair) => pair.call),
        shellPair.call,
      ]);
      expect(seenRequests[1].previousResponseId).toBe('resp-warmup');
      expect(seenRequests[1].input).toEqual([...parallelReads.map((pair) => pair.output), shellPair.output]);
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
    }
  },
);

it.sequential('CodexResponsesWSModel falls back to full history immediately after warmup network failure', async () => {
  const seenRequests: any[] = [];
  const networkError = Object.assign(new Error('Responses websocket connection closed before opening.'), {
    code: 'connection_closed_before_opening',
  });

  const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
    { role: 'user', type: 'message', content: 'first' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first response' }] },
    { role: 'user', type: 'message', content: 'next' },
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
    );

    for await (const _event of model.getStreamedResponse({
      input: fullInput,
      modelSettings: {},
      tools: [],
      handoffs: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(2);
    expect(seenRequests[0].modelSettings.providerData?.generate).toBe(false);
    expect(seenRequests[1].previousResponseId).toBe(undefined);
    expect(seenRequests[1].modelSettings.providerData?.generate).toBe(undefined);
    expect(seenRequests[1].input).toEqual(fullInput);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
  }
});

it.sequential(
  'CodexResponsesWSModel falls back to full history immediately after websocket network failure',
  async () => {
    const seenRequests: any[] = [];
    const networkError = Object.assign(new Error('Responses websocket connection closed before opening.'), {
      code: 'connection_closed_before_opening',
    });

    const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        return makeStream([
          {
            type: 'response.completed',
            response: {
              id: 'resp-stale-chain',
              output: [],
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

    const mockClient = {
      baseURL: 'https://api.openai.com',
      apiKey: 'test-key',
      _options: {},
    };
    const tokenManager = {
      getOrRefreshAccessToken: async () => 'token',
      getAccountId: () => 'acc_123',
    };

    const continuationInput = [
      { role: 'user', type: 'message', content: 'continue' },
      {
        type: 'function_call_result',
        callId: 'call_kQ5FnDgiK4ZWWNTvzPglQtEU',
        output: 'tool output',
      },
    ];

    try {
      const model = new CodexResponsesWSModel(
        mockClient as any,
        'gpt-5-codex',
        tokenManager as any,
        undefined,
        undefined,
        {
          getContext: () => ({ sessionId: 'session-network-repro', traceId: 'trace-network-repro' } as any),
          runWithContext: <T>(_context: any, fn: () => T) => fn(),
        },
      );

      for await (const _event of model.getStreamedResponse({
        previousResponseId: 'resp-root',
        input: [{ role: 'user', type: 'message', content: 'first turn' }],
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any)) {
      }

      for await (const _event of model.getStreamedResponse({
        input: continuationInput,
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any)) {
      }

      expect(seenRequests.length).toBe(3);
      expect(seenRequests[1].previousResponseId).toBe('resp-stale-chain');
      expect(seenRequests[1].input).toEqual([continuationInput[1]]);

      // After transport failure, stale chained history is cleared and the same
      // turn is replayed from full history without trying stateful history again.
      expect(seenRequests[2].previousResponseId).toBe(undefined);
      expect(seenRequests[2].modelSettings.providerData?.generate).toBe(undefined);
      expect(seenRequests[2].input).toEqual(continuationInput);
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
    }
  },
);

it.sequential('CodexResponsesWSModel invalidates Luna wire state on previous_response_not_found error', async () => {
  const seenRequests: any[] = [];
  let rejectedChainedContinuation = false;
  const prevNotFoundError = Object.assign(new Error('Previous response not found for id resp_stale'), {
    code: 'previous_response_not_found',
  });

  const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
    seenRequests.push(request);

    const isChainedContinuation =
      request.previousResponseId === 'resp_luna_ok' && request.input?.some((item: any) => item?.content === 'continue');
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
    );

    const userMsg = { role: 'user', type: 'message', content: 'hello' };
    const userMsg2 = { role: 'user', type: 'message', content: 'continue' };

    // First request: succeeds, establishes stored state.
    await collect(
      model.getStreamedResponse({
        input: [userMsg],
        systemInstructions: 'Do it.',
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any),
    );

    // Second request: chains off the first, but fails with prev-not-found.
    // The error triggers invalidation, then the fallback sends full input.
    await collect(
      model.getStreamedResponse({
        previousResponseId: 'resp_luna_ok',
        input: [userMsg, userMsg2],
        systemInstructions: 'Do it.',
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any),
    );

    // After invalidation, the exact fallback request replays full history
    // without trying to continue the stale response chain.
    expect(rejectedChainedContinuation).toBe(true);
    const failedRequestIndex = seenRequests.findIndex(
      (candidate) =>
        candidate.previousResponseId === 'resp_luna_ok' &&
        candidate.input?.some((item: any) => item?.content === 'continue'),
    );
    const fallbackRequests = seenRequests.slice(failedRequestIndex + 1);
    expect(fallbackRequests).not.toHaveLength(0);
    expect(fallbackRequests[0].previousResponseId).toBeUndefined();
    expect(fallbackRequests.flatMap((candidate) => candidate.input)).toEqual(
      expect.arrayContaining([userMsg, userMsg2]),
    );
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
  }
});

it.sequential(
  'CodexResponsesWSModel propagates stale tool continuations instead of replaying orphaned outputs',
  async () => {
    const seenRequests: any[] = [];
    const previousResponseNotFound = Object.assign(new Error('Previous response not found for id resp-stale'), {
      code: 'previous_response_not_found',
    });

    const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
      );

      await expect(
        collect(
          model.getStreamedResponse({
            previousResponseId: 'resp-stale',
            input: [
              { role: 'user', type: 'message', content: 'inspect the repo' },
              {
                type: 'function_call_result',
                callId: 'call-orphaned-output',
                output: 'tool output from the missing response',
              },
            ],
            modelSettings: {},
            tools: [],
            handoffs: [],
          } as any),
        ),
      ).rejects.toMatchObject({ code: 'previous_response_not_found' });

      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0].previousResponseId).toBe('resp-stale');
    } finally {
      (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
    }
  },
);

it.sequential('CodexResponsesWSModel unary path propagates stale tool continuations without fallback', async () => {
  const seenRequests: any[] = [];
  const previousResponseNotFound = Object.assign(new Error('Previous response not found for id resp-stale-unary'), {
    code: 'previous_response_not_found',
  });

  const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function (request: any) {
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
    );

    await expect(
      model.getResponse({
        previousResponseId: 'resp-stale-unary',
        input: [
          { role: 'user', type: 'message', content: 'inspect the repo' },
          {
            type: 'function_call_result',
            callId: 'call-orphaned-output-unary',
            output: 'tool output from the missing response',
          },
        ],
        modelSettings: {},
        tools: [],
        handoffs: [],
      } as any),
    ).rejects.toMatchObject({ code: 'previous_response_not_found' });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-stale-unary');
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
  }
});

it.sequential('CodexResponsesWSModel unary path records Luna wire state response with correct token', async () => {
  const originalFetch = (OpenAIResponsesWSModel.prototype as any)._fetchResponse;
  const trafficBodies: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordRequestFailed() {},
  };

  (OpenAIResponsesWSModel.prototype as any)._fetchResponse = async function () {
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
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-unary-token', traceId: 'trace-unary-token' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
    );

    const msg1 = { role: 'user', type: 'message', content: 'unary first' };
    const msg2 = { role: 'user', type: 'message', content: 'unary second' };

    // First unary call establishes stored state.
    await model.getResponse({
      input: [msg1],
      systemInstructions: 'Do it.',
      modelSettings: {},
      tools: [],
      handoffs: [],
    } as any);

    // Second unary call chains off first and should produce a delta.
    await model.getResponse({
      previousResponseId: 'resp_unary_luna_2',
      input: [msg2],
      systemInstructions: 'Do it.',
      modelSettings: {},
      tools: [],
      handoffs: [],
    } as any);

    // The second call's final request body (third traffic entry) should
    // carry only the new user message as a delta.
    expect(trafficBodies).toHaveLength(3);
    expect(trafficBodies[2].previous_response_id).toBe('resp_unary_luna_2');
    expect(trafficBodies[2].input).toEqual([expect.objectContaining({ role: 'user', content: 'unary second' })]);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._fetchResponse = originalFetch;
  }
});
