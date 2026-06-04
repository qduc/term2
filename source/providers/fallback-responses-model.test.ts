import test from 'ava';
import { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { FallbackResponsesModel, isNetworkProtocolError } from './fallback-responses-model.js';

function makeMockModel(
  options: {
    getResponse?: (request: ModelRequest) => Promise<ModelResponse>;
    getStreamedResponse?: (request: ModelRequest) => AsyncIterable<StreamEvent>;
    getRetryAdvice?: (args: any) => any;
  },
  className = 'MockModel',
): Model {
  const model = {
    getResponse: options.getResponse || (async () => ({} as any)),
    getStreamedResponse: options.getStreamedResponse || (async function* () {} as any),
    ...(options.getRetryAdvice ? { getRetryAdvice: options.getRetryAdvice } : {}),
  };
  Object.defineProperty(model, 'constructor', {
    value: { name: className },
    configurable: true,
  });
  return model as Model;
}

test('isNetworkProtocolError correctly flags network protocol errors', (t) => {
  // System network errors
  t.true(isNetworkProtocolError({ code: 'ENOTFOUND' }));
  t.true(isNetworkProtocolError({ code: 'ECONNREFUSED' }));
  t.true(isNetworkProtocolError({ code: 'ETIMEDOUT' }));
  t.true(isNetworkProtocolError({ code: 'ECONNRESET' }));

  // WebSocket message signatures
  t.true(isNetworkProtocolError(new Error('Responses websocket connection closed before opening.')));
  t.true(isNetworkProtocolError(new Error('Responses websocket connection closed before a terminal response event.')));
  t.true(isNetworkProtocolError(new Error('Responses websocket is not open.')));
  t.true(isNetworkProtocolError(new Error('unexpected server response: 502')));
  t.true(isNetworkProtocolError(new Error('Responses websocket connection timed out before opening after 15000ms')));
  t.true(isNetworkProtocolError(new Error('Responses websocket connection timed out')));
  t.true(isNetworkProtocolError(new Error('WebSocket first frame timeout after 5000ms')));
  t.true(isNetworkProtocolError({ name: 'InvalidStateError', message: 'Socket is closing' }));

  // Exclusions (auth and rate limits)
  t.false(isNetworkProtocolError(new Error('unexpected server response: 401')));
  t.false(isNetworkProtocolError(new Error('unexpected server response: 403')));
  t.false(isNetworkProtocolError(new Error('unexpected server response: 429')));
  t.false(isNetworkProtocolError(new Error('unexpected server response: 400')));
  t.false(isNetworkProtocolError(new Error('unexpected server response: 404')));
  t.true(isNetworkProtocolError(new Error('unexpected server response: 502')));

  // Generic non-network errors
  t.false(isNetworkProtocolError(new Error('Something else went wrong')));
  t.false(isNetworkProtocolError({}));
  t.false(isNetworkProtocolError(null));
});

test('FallbackResponsesModel.getResponse uses WS model by default and falls back on network error', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;
  let downgradeLogged = false;

  const wsError = new Error('Responses websocket connection closed before opening.');
  const expectedResponse: ModelResponse = { usage: {} as any, output: [] };

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw wsError;
    },
  });

  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return expectedResponse;
    },
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, (err) => {
    t.is(err, wsError);
    downgradeLogged = true;
  });

  const result = await model.getResponse({} as any);

  t.is(wsCalled, 1);
  t.is(httpCalled, 1);
  t.true(state.isDowngraded);
  t.true(downgradeLogged);
  t.is(result, expectedResponse);

  // Subsequent call should skip WS model and go directly to HTTP model
  const result2 = await model.getResponse({} as any);
  t.is(wsCalled, 1); // still 1
  t.is(httpCalled, 2);
  t.is(result2, expectedResponse);
});

test('FallbackResponsesModel injects Codex previous response id and trims replayed tool-continuation input', async (t) => {
  const seenRequests: ModelRequest[] = [];
  const toolOutput = {
    type: 'function_call_output',
    call_id: 'call-read',
    output: 'done',
  };

  const wsModel = makeMockModel({
    getStreamedResponse: async function* (request: ModelRequest) {
      seenRequests.push(request);
      yield {
        type: 'response_done',
        response: {
          id: seenRequests.length === 1 ? 'resp-1' : 'resp-2',
          output: [],
          usage: {},
        },
      } as any;
    },
  });

  const model = new FallbackResponsesModel(
    wsModel,
    makeMockModel({}),
    { isDowngraded: false },
    undefined,
    undefined,
    'codex',
    {
      getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    },
  );

  for await (const _event of model.getStreamedResponse({
    input: [{ role: 'user', type: 'message', content: 'inspect' }],
    modelSettings: {},
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
  } as any)) {
  }

  t.is(seenRequests.length, 4);
  t.is(seenRequests[3].previousResponseId, 'resp-explicit');
  t.deepEqual(seenRequests[3].input, [latestUser]);
});

test('FallbackResponsesModel retries safe Codex warm-up failures before chaining the delta request', async (t) => {
  const seenRequests: ModelRequest[] = [];
  const safeWarmupError = Object.assign(new Error('Responses websocket connection closed before opening.'), {
    code: 'connection_closed_before_opening',
  });

  const wsModel = makeMockModel({
    getResponse: async (request: ModelRequest) => {
      seenRequests.push(request);
      if (seenRequests.length === 1) {
        throw safeWarmupError;
      }
      return {
        responseId: seenRequests.length === 2 ? 'resp-warmup' : 'resp-main',
        output: [],
        usage: {} as any,
      };
    },
    getRetryAdvice: ({ error }: any) =>
      error === safeWarmupError ? { suggested: true, replaySafety: 'safe' } : { suggested: false },
  });

  const model = new FallbackResponsesModel(
    wsModel,
    makeMockModel({}),
    { isDowngraded: false },
    undefined,
    undefined,
    'codex',
    {
      getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    },
  );

  const latestUser = { role: 'user', type: 'message', content: 'next' };
  await model.getResponse({
    input: [
      { role: 'user', type: 'message', content: 'first' },
      { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first response' }] },
      latestUser,
    ],
    modelSettings: {},
  } as any);

  t.is(seenRequests.length, 3);
  t.is(seenRequests[0].modelSettings.providerData?.generate, false);
  t.is(seenRequests[1].modelSettings.providerData?.generate, false);
  t.deepEqual(seenRequests[0].input, seenRequests[1].input);
  t.is(seenRequests[2].previousResponseId, 'resp-warmup');
  t.deepEqual(seenRequests[2].input, [latestUser]);
});

test('FallbackResponsesModel falls back to full history without previous response id when safe Codex warm-up retries are exhausted', async (t) => {
  const seenRequests: ModelRequest[] = [];
  const safeWarmupError = Object.assign(new Error('Responses websocket connection closed before opening.'), {
    code: 'connection_closed_before_opening',
  });

  const wsModel = makeMockModel({
    getStreamedResponse: async function* (request: ModelRequest) {
      seenRequests.push(request);
      if (seenRequests.length <= 3) {
        throw safeWarmupError;
      }
      yield {
        type: 'response_done',
        response: {
          id: 'resp-main',
          output: [],
          usage: {},
        },
      } as any;
    },
    getRetryAdvice: ({ error }: any) =>
      error === safeWarmupError ? { suggested: true, replaySafety: 'safe' } : { suggested: false },
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, makeMockModel({}), state, undefined, undefined, 'codex', {
    getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
  });

  const fullInput = [
    { role: 'user', type: 'message', content: 'first' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first response' }] },
    { role: 'user', type: 'message', content: 'next' },
  ];
  for await (const _event of model.getStreamedResponse({
    input: fullInput,
    modelSettings: {},
  } as any)) {
  }

  t.is(seenRequests.length, 4);
  t.true(seenRequests.slice(0, 3).every((request) => request.modelSettings.providerData?.generate === false));
  t.deepEqual(seenRequests[3].input, fullInput);
  t.is(seenRequests[3].previousResponseId, undefined);
  t.is(seenRequests[3].modelSettings.providerData?.generate, undefined);
  t.false(state.isDowngraded);
});

test('FallbackResponsesModel.getResponse immediately throws non-network errors without falling back', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;

  const wsError = new Error('unexpected server response: 401');

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw wsError;
    },
  });

  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return {} as any;
    },
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state);

  await t.throwsAsync(
    async () => {
      await model.getResponse({} as any);
    },
    { message: 'unexpected server response: 401' },
  );

  t.is(wsCalled, 1);
  t.is(httpCalled, 0);
  t.false(state.isDowngraded);
});

test('FallbackResponsesModel.getResponse falls back to HTTP when WS returns response with undefined output (SDK convertToOutputItem crash)', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;
  let downgradeFired = false;

  const sdkCrash = new TypeError("Cannot read properties of undefined (reading 'map')");

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw sdkCrash;
    },
  });

  const httpResponse = { output: [], usage: {} } as any;
  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return httpResponse;
    },
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, () => {
    downgradeFired = true;
  });

  const result = await model.getResponse({} as any);

  t.is(wsCalled, 1);
  t.is(httpCalled, 1);
  t.is(result, httpResponse);
  t.true(state.isDowngraded);
  t.true(downgradeFired);
});

test('FallbackResponsesModel.getStreamedResponse falls back seamlessly if error occurs before any events', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;
  let downgradeLogged = false;

  const wsError = new Error('Responses websocket connection closed before opening.');
  const wsModel = makeMockModel({
    getStreamedResponse: async function* () {
      wsCalled++;
      throw wsError;
    } as any,
  });

  const httpModel = makeMockModel({
    getStreamedResponse: async function* () {
      httpCalled++;
      yield { type: 'response_started' } as any;
      yield { type: 'output_text_delta', delta: 'Hello' } as any;
    } as any,
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, (err) => {
    t.is(err, wsError);
    downgradeLogged = true;
  });

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({} as any)) {
    events.push(event);
  }

  t.is(wsCalled, 1);
  t.is(httpCalled, 1);
  t.true(state.isDowngraded);
  t.true(downgradeLogged);
  t.deepEqual(events, [{ type: 'response_started' }, { type: 'output_text_delta', delta: 'Hello' }]);
});

test('FallbackResponsesModel.getStreamedResponse propagates error and does not fallback if any output already streamed', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;
  let downgradeLogged = false;

  const wsError = new Error('socket hang up');
  const wsModel = makeMockModel({
    getStreamedResponse: async function* () {
      wsCalled++;
      yield { type: 'output_text_delta', delta: 'Partial' } as any;
      throw wsError;
    } as any,
  });

  const httpModel = makeMockModel({
    getStreamedResponse: async function* () {
      httpCalled++;
      yield { type: 'output_text_delta', delta: 'Fallback Hello' } as any;
    } as any,
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, (err) => {
    t.is(err, wsError);
    downgradeLogged = true;
  });

  const events: any[] = [];
  await t.throwsAsync(
    async () => {
      for await (const event of model.getStreamedResponse({} as any)) {
        events.push(event);
      }
    },
    { message: 'socket hang up' },
  );

  t.is(wsCalled, 1);
  t.is(httpCalled, 0); // No HTTP fallback!
  t.true(state.isDowngraded); // Still downgrades for future requests!
  t.true(downgradeLogged);
  t.deepEqual(events, [{ type: 'output_text_delta', delta: 'Partial' }]);
});

test('FallbackResponsesModel logs unary WS request start, success, and failure events', async (t) => {
  const wsModel = makeMockModel(
    {
      getResponse: async () => {
        return {
          usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 } as any,
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello back' }] }] as any,
          providerData: { id: 'resp_ws_123' },
        };
      },
    },
    'TimedResponsesWSModel',
  );
  (wsModel as any)._buildResponsesCreateRequest = (_request: any, _stream: boolean) => {
    return {
      requestData: { messages: [] },
      sdkRequestHeaders: {
        Authorization: 'Bearer ws-token-123',
        'x-opencode-session': 'session-ws-abc',
      },
    };
  };
  const httpModel = makeMockModel({});
  const state = { isDowngraded: false };

  const logs: any[] = [];
  const mockLogging = {
    getCorrelationId: () => 'corr-123',
    debug: (msg: string, meta: any) => {
      logs.push({ level: 'debug', msg, meta });
    },
    error: (msg: string, meta: any) => {
      logs.push({ level: 'error', msg, meta });
    },
  };
  const mockSessionContext = {
    getContext: () => ({ sessionId: 'sess-123', sessionStartedAt: '2026-05-24T12:00:00Z' }),
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
  };

  const model = new FallbackResponsesModel(
    wsModel,
    httpModel,
    state,
    undefined,
    mockLogging,
    'openai',
    mockSessionContext,
  );

  const request: ModelRequest = {
    input: 'Hello',
    modelSettings: { providerData: { model: 'gpt-4o' } },
    tools: [],
    handoffs: [],
    tracing: false,
    outputType: {} as any,
  };

  await model.getResponse(request);

  t.is(logs.length, 2);
  t.is(logs[0].level, 'debug');
  t.is(logs[0].meta.eventType, 'provider.request.started');
  t.is(logs[0].meta.provider, 'openai');
  t.is(logs[0].meta.model, 'gpt-4o');
  t.is(logs[0].meta.modelClass, 'TimedResponsesWSModel');
  t.is(logs[0].meta.modelWrapperClass, 'FallbackResponsesModel');
  t.deepEqual(logs[0].meta.headers, {
    authorization: '[REDACTED]',
    'x-opencode-session': 'session-ws-abc',
  });

  t.is(logs[1].level, 'debug');
  t.is(logs[1].meta.eventType, 'provider.response.received');
  t.is(logs[1].meta.text, 'Hello back');
  t.is(logs[1].meta.payload.transport, 'json');
  t.is(logs[1].meta.payload.payload.id, 'resp_ws_123');

  // Test failure logging
  logs.length = 0;
  const failingWsModel = makeMockModel({
    getResponse: async () => {
      throw new Error('websocket connection closed before opening');
    },
  });
  const modelFail = new FallbackResponsesModel(failingWsModel, httpModel, state, undefined, mockLogging, 'openai');

  await modelFail.getResponse(request);
  t.is(logs.length, 2); // 1 request start, 1 failure complete (which falls back to HTTP, but httpModel is mock/empty)
  t.is(logs[0].meta.eventType, 'provider.request.started');
  t.is(logs[1].level, 'error');
  t.is(logs[1].meta.eventType, 'provider.response.failed');
  t.is(logs[1].meta.error, 'websocket connection closed before opening');
});

test('FallbackResponsesModel falls back to HTTP when WebSocket times out', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;

  const wsError = new Error('WebSocket open timed out after 15000ms');
  const expectedResponse: ModelResponse = { usage: {} as any, output: [] };

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw wsError;
    },
  });

  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return expectedResponse;
    },
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state);

  const result = await model.getResponse({} as any);

  t.is(wsCalled, 1);
  t.is(httpCalled, 1);
  t.true(state.isDowngraded);
  t.is(result, expectedResponse);

  // Subsequent calls should skip WS and use HTTP directly
  const result2 = await model.getResponse({} as any);
  t.is(wsCalled, 1);
  t.is(httpCalled, 2);
  t.is(result2, expectedResponse);
});

test('FallbackResponsesModel logs streaming WS request start and response completion events', async (t) => {
  const wsModel = makeMockModel(
    {
      getStreamedResponse: async function* () {
        yield {
          type: 'model',
          event: {
            type: 'response.output_text.delta',
            delta: 'Hello',
          },
        } as any;
        yield {
          type: 'model',
          event: {
            type: 'response.completed',
            response: {
              id: 'resp_ws_stream_123',
              output: [
                {
                  type: 'message',
                  id: 'msg_1',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Hello' }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        } as any;
      } as any,
    },
    'TimedResponsesWSModel',
  );

  const httpModel = makeMockModel({});
  const state = { isDowngraded: false };

  const logs: any[] = [];
  const mockLogging = {
    getCorrelationId: () => 'corr-123',
    debug: (msg: string, meta: any) => {
      logs.push({ level: 'debug', msg, meta });
    },
  };
  const mockSessionContext = {
    getContext: () => ({ sessionId: 'sess-123', sessionStartedAt: '2026-05-24T12:00:00Z' }),
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
  };

  const model = new FallbackResponsesModel(
    wsModel,
    httpModel,
    state,
    undefined,
    mockLogging,
    'openai',
    mockSessionContext,
  );

  const request: ModelRequest = {
    input: 'Hello',
    modelSettings: { providerData: { model: 'gpt-4o' } },
    tools: [],
    handoffs: [],
    tracing: false,
    outputType: {} as any,
  };

  // Consume stream
  for await (const _ of model.getStreamedResponse(request)) {
  }

  t.is(logs.length, 2);
  t.is(logs[0].meta.eventType, 'provider.request.started');
  t.is(logs[0].meta.modelClass, 'TimedResponsesWSModel');
  t.is(logs[0].meta.modelWrapperClass, 'FallbackResponsesModel');
  t.is(logs[1].meta.eventType, 'provider.response.received');
  t.is(logs[1].meta.text, 'Hello'); // parsed delta content
  t.is(logs[1].meta.payload.transport, 'sse'); // parsed as text/event-stream sse
  t.is(logs[1].meta.payload.payload.id, 'resp_ws_stream_123');
});

test('FallbackResponsesModel.getResponse retries WS up to 2 times on first-frame timeout then downgrades', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;
  let downgradeLogged = false;

  const firstFrameError = new Error('WebSocket first frame timeout after 5000ms');
  const expectedResponse: ModelResponse = { usage: {} as any, output: [] };

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw firstFrameError;
    },
  });
  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return expectedResponse;
    },
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, () => {
    downgradeLogged = true;
  });

  const result = await model.getResponse({} as any);

  t.is(wsCalled, 3, 'should attempt WS 3 times (initial + 2 retries)');
  t.is(httpCalled, 1);
  t.true(state.isDowngraded);
  t.true(downgradeLogged);
  t.is(result, expectedResponse);
});

test('FallbackResponsesModel.getResponse succeeds on retry after first-frame timeout without downgrading', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;

  const firstFrameError = new Error('WebSocket first frame timeout after 5000ms');
  const expectedResponse: ModelResponse = { usage: {} as any, output: [] };

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      if (wsCalled < 2) {
        throw firstFrameError;
      }
      return expectedResponse;
    },
  });
  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return {} as any;
    },
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state);

  const result = await model.getResponse({} as any);

  t.is(wsCalled, 2);
  t.is(httpCalled, 0);
  t.false(state.isDowngraded);
  t.is(result, expectedResponse);
});

test('FallbackResponsesModel.getResponse downgrades immediately on non-first-frame network errors', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;

  const wsError = new Error('WebSocket idle timeout after 300000ms');
  const expectedResponse: ModelResponse = { usage: {} as any, output: [] };

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw wsError;
    },
  });
  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return expectedResponse;
    },
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state);

  const result = await model.getResponse({} as any);

  t.is(wsCalled, 1, 'idle timeout should not trigger first-frame retry path');
  t.is(httpCalled, 1);
  t.true(state.isDowngraded);
  t.is(result, expectedResponse);
});

test('FallbackResponsesModel.getResponse retries abnormal websocket close 1006 before downgrading', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;

  const abnormalCloseError = new Error('WebSocket connection closed before response completed (code=1006)');
  const expectedResponse: ModelResponse = { usage: {} as any, output: [] };

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      if (wsCalled === 1) {
        throw abnormalCloseError;
      }

      return expectedResponse;
    },
  });
  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return {} as any;
    },
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state);

  const result = await model.getResponse({} as any);

  t.is(wsCalled, 2);
  t.is(httpCalled, 0);
  t.false(state.isDowngraded);
  t.is(result, expectedResponse);
});

test('FallbackResponsesModel.getStreamedResponse retries WS up to 2 times on first-frame timeout then downgrades', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;
  let downgradeLogged = false;

  const firstFrameError = new Error('WebSocket first frame timeout after 5000ms');
  const wsModel = makeMockModel({
    getStreamedResponse: async function* () {
      wsCalled++;
      throw firstFrameError;
    } as any,
  });
  const httpModel = makeMockModel({
    getStreamedResponse: async function* () {
      httpCalled++;
      yield { type: 'response_started' } as any;
    } as any,
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, () => {
    downgradeLogged = true;
  });

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({} as any)) {
    events.push(event);
  }

  t.is(wsCalled, 3, 'should attempt WS 3 times (initial + 2 retries)');
  t.is(httpCalled, 1);
  t.true(state.isDowngraded);
  t.true(downgradeLogged);
  t.deepEqual(events, [{ type: 'response_started' }]);
});

test('FallbackResponsesModel.getStreamedResponse retries abnormal websocket close 1006 before downgrading', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;

  const abnormalCloseError = new Error('WebSocket connection closed before response completed (code=1006)');
  const wsModel = makeMockModel({
    getStreamedResponse: async function* () {
      wsCalled++;
      if (wsCalled === 1) {
        throw abnormalCloseError;
      }

      yield { type: 'response_started' } as any;
    } as any,
  });
  const httpModel = makeMockModel({
    getStreamedResponse: async function* () {
      httpCalled++;
      yield { type: 'output_text_delta', delta: 'fallback' } as any;
    } as any,
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state);

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({} as any)) {
    events.push(event);
  }

  t.is(wsCalled, 2);
  t.is(httpCalled, 0);
  t.false(state.isDowngraded);
  t.deepEqual(events, [{ type: 'response_started' }]);
});

test('FallbackResponsesModel.getStreamedResponse does not retry once events have been yielded', async (t) => {
  let wsCalled = 0;

  const firstFrameError = new Error('WebSocket first frame timeout after 5000ms');
  const wsModel = makeMockModel({
    getStreamedResponse: async function* () {
      wsCalled++;
      yield { type: 'output_text_delta', delta: 'partial' } as any;
      throw firstFrameError;
    } as any,
  });
  const httpModel = makeMockModel({
    getStreamedResponse: async function* () {
      yield { type: 'output_text_delta', delta: 'fallback' } as any;
    } as any,
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state);

  const events: any[] = [];
  await t.throwsAsync(
    async () => {
      for await (const event of model.getStreamedResponse({} as any)) {
        events.push(event);
      }
    },
    { message: /first frame timeout/ },
  );

  t.is(wsCalled, 1, 'should not retry once a frame has been yielded');
  t.true(state.isDowngraded, 'still flips downgrade flag for future requests');
  t.deepEqual(events, [{ type: 'output_text_delta', delta: 'partial' }]);
});

test('FallbackResponsesModel.getStreamedResponse does not flip downgrade flag on mid-stream idle timeout', async (t) => {
  let wsCalled = 0;
  let downgradeLogged = false;

  const idleError = new Error('WebSocket idle timeout after 300000ms');
  const wsModel = makeMockModel({
    getStreamedResponse: async function* () {
      wsCalled++;
      yield { type: 'output_text_delta', delta: 'partial' } as any;
      throw idleError;
    } as any,
  });
  const httpModel = makeMockModel({
    getStreamedResponse: async function* () {
      yield { type: 'output_text_delta', delta: 'fallback' } as any;
    } as any,
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, () => {
    downgradeLogged = true;
  });

  const events: any[] = [];
  await t.throwsAsync(
    async () => {
      for await (const event of model.getStreamedResponse({} as any)) {
        events.push(event);
      }
    },
    { message: /idle timeout/ },
  );

  t.is(wsCalled, 1);
  t.false(state.isDowngraded, 'one transient mid-stream stall should not flip the session-wide downgrade flag');
  t.false(downgradeLogged);
  t.deepEqual(events, [{ type: 'output_text_delta', delta: 'partial' }]);
});

test('FallbackResponsesModel.getStreamedResponse still flips downgrade on pre-stream idle timeout', async (t) => {
  let wsCalled = 0;
  let httpCalled = 0;

  const idleError = new Error('WebSocket idle timeout after 300000ms');
  const wsModel = makeMockModel({
    getStreamedResponse: async function* () {
      wsCalled++;
      throw idleError;
    } as any,
  });
  const httpModel = makeMockModel({
    getStreamedResponse: async function* () {
      httpCalled++;
      yield { type: 'response_started' } as any;
    } as any,
  });

  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state);

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({} as any)) {
    events.push(event);
  }

  t.is(wsCalled, 1);
  t.is(httpCalled, 1);
  t.true(state.isDowngraded, 'no events yielded → idle timeout still indicates a broken WS path');
  t.deepEqual(events, [{ type: 'response_started' }]);
});
