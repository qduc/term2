import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import {
  FallbackResponsesModel,
  isNetworkProtocolError,
  ChainingTransportDowngradeError,
  DEFAULT_STREAM_MAX_RETRIES,
} from './fallback-responses-model.js';

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

function createSleepRecorder() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (delayMs: number) => {
      delays.push(delayMs);
    },
  };
}

it('isNetworkProtocolError correctly flags network protocol errors', () => {
  // System network errors
  expect(isNetworkProtocolError({ code: 'ENOTFOUND' })).toBe(true);
  expect(isNetworkProtocolError({ code: 'ECONNREFUSED' })).toBe(true);
  expect(isNetworkProtocolError({ code: 'ETIMEDOUT' })).toBe(true);
  expect(isNetworkProtocolError({ code: 'ECONNRESET' })).toBe(true);

  // WebSocket message signatures
  expect(isNetworkProtocolError(new Error('Responses websocket connection closed before opening.'))).toBe(true);
  expect(
    isNetworkProtocolError(new Error('Responses websocket connection closed before a terminal response event.')),
  ).toBe(true);
  expect(isNetworkProtocolError(new Error('Responses websocket is not open.'))).toBe(true);
  expect(isNetworkProtocolError(new Error('unexpected server response: 502'))).toBe(true);
  expect(
    isNetworkProtocolError(new Error('Responses websocket connection timed out before opening after 15000ms')),
  ).toBe(true);
  expect(isNetworkProtocolError(new Error('Responses websocket connection timed out'))).toBe(true);
  expect(isNetworkProtocolError(new Error('WebSocket first frame timeout after 5000ms'))).toBe(true);
  expect(isNetworkProtocolError({ name: 'InvalidStateError', message: 'Socket is closing' })).toBe(true);

  // Exclusions (auth and rate limits)
  expect(isNetworkProtocolError(new Error('unexpected server response: 401'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 403'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 429'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 400'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 404'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 502'))).toBe(true);

  // Generic non-network errors
  expect(isNetworkProtocolError(new Error('Something else went wrong'))).toBe(false);
  expect(isNetworkProtocolError({})).toBe(false);
  expect(isNetworkProtocolError(null)).toBe(false);
});

it('FallbackResponsesModel.getResponse uses WS model by default and falls back on network error', async () => {
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

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const sleep = createSleepRecorder();
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(
    wsModel,
    httpModel,
    state,
    (err) => {
      expect(err).toBe(wsError);
      downgradeLogged = true;
    },
    undefined,
    undefined,
    undefined,
    { sleep: sleep.sleep, random: () => 0.5 },
  );

  const result = await model.getResponse({} as any);

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(downgradeLogged).toBe(true);
  expect(result).toBe(expectedResponse);
  expect(sleep.delays.length, 'should sleep between WS retries').toBe(DEFAULT_STREAM_MAX_RETRIES);

  // Subsequent call should skip WS model and go directly to HTTP model
  const result2 = await model.getResponse({} as any);
  expect(wsCalled).toBe(expectedWsAttempts); // still same count
  expect(httpCalled).toBe(2);
  expect(result2).toBe(expectedResponse);
});

it('FallbackResponsesModel.getResponse immediately throws non-network errors without falling back', async () => {
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

  await expect(async () => {
    await model.getResponse({} as any);
  }).rejects.toThrow('unexpected server response: 401');

  expect(wsCalled).toBe(1);
  expect(httpCalled).toBe(0);
  expect(state.isDowngraded).toBe(false);
});

it('FallbackResponsesModel.getResponse falls back to HTTP when WS returns response with undefined output (SDK convertToOutputItem crash)', async () => {
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

  // SDK crash is deterministic — should fall back to HTTP immediately, not retry WS
  expect(wsCalled).toBe(1);
  expect(httpCalled).toBe(1);
  expect(result).toBe(httpResponse);
  expect(state.isDowngraded).toBe(true);
  expect(downgradeFired).toBe(true);
});

it('FallbackResponsesModel.getStreamedResponse falls back seamlessly if error occurs before any events', async () => {
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

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const sleep = createSleepRecorder();
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(
    wsModel,
    httpModel,
    state,
    (err) => {
      expect(err).toBe(wsError);
      downgradeLogged = true;
    },
    undefined,
    undefined,
    undefined,
    { sleep: sleep.sleep, random: () => 0.5 },
  );

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({} as any)) {
    events.push(event);
  }

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(downgradeLogged).toBe(true);
  expect(events).toEqual([{ type: 'response_started' }, { type: 'output_text_delta', delta: 'Hello' }]);
});

it('FallbackResponsesModel.getStreamedResponse propagates error and does not fallback if any output already streamed', async () => {
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
    expect(err).toBe(wsError);
    downgradeLogged = true;
  });

  const events: any[] = [];

  await expect(async () => {
    for await (const event of model.getStreamedResponse({} as any)) {
      events.push(event);
    }
  }).rejects.toThrow('socket hang up');

  expect(wsCalled).toBe(1);
  expect(httpCalled).toBe(0); // No HTTP fallback!
  expect(state.isDowngraded).toBe(false);
  expect(downgradeLogged).toBe(false);
  expect(events).toEqual([{ type: 'output_text_delta', delta: 'Partial' }]);
});

it('FallbackResponsesModel logs unary WS request start, success, and failure events', async () => {
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
    'OpenAIResponsesWSModelWithPromptCacheKey',
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

  expect(logs.length).toBe(2);
  expect(logs[0].level).toBe('debug');
  expect(logs[0].meta.eventType).toBe('provider.request.started');
  expect(logs[0].meta.provider).toBe('openai');
  expect(logs[0].meta.model).toBe('gpt-4o');
  expect(logs[0].meta.modelClass).toBe('OpenAIResponsesWSModelWithPromptCacheKey');
  expect(logs[0].meta.modelWrapperClass).toBe('FallbackResponsesModel');
  expect(logs[0].meta.headers).toEqual({
    authorization: '[REDACTED]',
    'x-opencode-session': 'session-ws-abc',
  });

  expect(logs[1].level).toBe('debug');
  expect(logs[1].meta.eventType).toBe('provider.response.received');
  expect(logs[1].meta.text).toBe('Hello back');
  expect(logs[1].meta.payload.transport).toBe('json');
  expect(logs[1].meta.payload.payload.id).toBe('resp_ws_123');

  // Test failure logging
  logs.length = 0;
  const failingWsModel = makeMockModel({
    getResponse: async () => {
      throw new Error('websocket connection closed before opening');
    },
  });
  const modelFail = new FallbackResponsesModel(
    failingWsModel,
    httpModel,
    state,
    undefined,
    mockLogging,
    'openai',
    undefined,
    { sleep: async () => {}, random: () => 0.5 },
  );

  await modelFail.getResponse(request);
  // 1 request start + DEFAULT_STREAM_MAX_RETRIES + 1 failure logs (one per WS attempt)
  expect(logs.length).toBe(1 + DEFAULT_STREAM_MAX_RETRIES + 1);
  expect(logs[0].meta.eventType).toBe('provider.request.started');
  // Each retry attempt logs a failure
  for (let i = 1; i <= DEFAULT_STREAM_MAX_RETRIES + 1; i++) {
    expect(logs[i].level).toBe('error');
    expect(logs[i].meta.eventType).toBe('provider.response.failed');
    expect(logs[i].meta.error).toBe('websocket connection closed before opening');
    expect(logs[i].meta.wsAttempt).toBe(i);
    expect(logs[i].meta.wsMaxAttempts).toBe(DEFAULT_STREAM_MAX_RETRIES + 1);
  }
});

it('FallbackResponsesModel falls back to HTTP when WebSocket times out', async () => {
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

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  const result = await model.getResponse({} as any);

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(result).toBe(expectedResponse);

  // Subsequent calls should skip WS and use HTTP directly
  const result2 = await model.getResponse({} as any);
  expect(wsCalled).toBe(expectedWsAttempts);
  expect(httpCalled).toBe(2);
  expect(result2).toBe(expectedResponse);
});

it('FallbackResponsesModel logs streaming WS request start and response completion events', async () => {
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
    'OpenAIResponsesWSModelWithPromptCacheKey',
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

  expect(logs.length).toBe(2);
  expect(logs[0].meta.eventType).toBe('provider.request.started');
  expect(logs[0].meta.modelClass).toBe('OpenAIResponsesWSModelWithPromptCacheKey');
  expect(logs[0].meta.modelWrapperClass).toBe('FallbackResponsesModel');
  expect(logs[1].meta.eventType).toBe('provider.response.received');
  expect(logs[1].meta.text).toBe('Hello'); // parsed delta content
  expect(logs[1].meta.payload.transport).toBe('sse'); // parsed as text/event-stream sse
  expect(logs[1].meta.payload.payload.id).toBe('resp_ws_stream_123');
});

it('FallbackResponsesModel.getResponse falls back after exhausting WS retries on pre-response failure', async () => {
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

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const sleep = createSleepRecorder();
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(
    wsModel,
    httpModel,
    state,
    () => {
      downgradeLogged = true;
    },
    undefined,
    undefined,
    undefined,
    { sleep: sleep.sleep, random: () => 0.5 },
  );

  const result = await model.getResponse({} as any);

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(downgradeLogged).toBe(true);
  expect(result).toBe(expectedResponse);
});

it('FallbackResponsesModel.getResponse retries first-frame timeout before falling back to HTTP', async () => {
  let wsCalled = 0;
  let httpCalled = 0;

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

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  const result = await model.getResponse({} as any);

  expect(wsCalled, 'should retry WS before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(result).toBe(expectedResponse);
});

it('FallbackResponsesModel.getResponse falls back after exhausting WS retries for pre-response network errors', async () => {
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

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  const result = await model.getResponse({} as any);

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(result).toBe(expectedResponse);
});

it('FallbackResponsesModel.getResponse falls back after exhausting WS retries for abnormal websocket close 1006', async () => {
  let wsCalled = 0;
  let httpCalled = 0;

  const abnormalCloseError = new Error('WebSocket connection closed before response completed (code=1006)');
  const expectedResponse: ModelResponse = { usage: {} as any, output: [] };

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw abnormalCloseError;
    },
  });
  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return expectedResponse;
    },
  });

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  const result = await model.getResponse({} as any);

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(result).toBe(expectedResponse);
});

it('FallbackResponsesModel.getStreamedResponse falls back after exhausting WS retries on pre-stream failure', async () => {
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

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const sleep = createSleepRecorder();
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(
    wsModel,
    httpModel,
    state,
    () => {
      downgradeLogged = true;
    },
    undefined,
    undefined,
    undefined,
    { sleep: sleep.sleep, random: () => 0.5 },
  );

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({} as any)) {
    events.push(event);
  }

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(downgradeLogged).toBe(true);
  expect(events).toEqual([{ type: 'response_started' }]);
});

it('FallbackResponsesModel.getStreamedResponse falls back after exhausting WS retries for abnormal websocket close 1006', async () => {
  let wsCalled = 0;
  let httpCalled = 0;

  const abnormalCloseError = new Error('WebSocket connection closed before response completed (code=1006)');
  const wsModel = makeMockModel({
    getStreamedResponse: async function* () {
      wsCalled++;
      throw abnormalCloseError;
    } as any,
  });
  const httpModel = makeMockModel({
    getStreamedResponse: async function* () {
      httpCalled++;
      yield { type: 'output_text_delta', delta: 'fallback' } as any;
    } as any,
  });

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({} as any)) {
    events.push(event);
  }

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(events).toEqual([{ type: 'output_text_delta', delta: 'fallback' }]);
});

it('FallbackResponsesModel.getStreamedResponse does not retry once events have been yielded', async () => {
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

  await expect(async () => {
    for await (const event of model.getStreamedResponse({} as any)) {
      events.push(event);
    }
  }).rejects.toThrow(/first frame timeout/);

  expect(wsCalled, 'should not retry once a frame has been yielded').toBe(1);
  expect(state.isDowngraded).toBe(false);
  expect(events).toEqual([{ type: 'output_text_delta', delta: 'partial' }]);
});

it('FallbackResponsesModel.getStreamedResponse does not flip downgrade flag on mid-stream idle timeout', async () => {
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

  await expect(async () => {
    for await (const event of model.getStreamedResponse({} as any)) {
      events.push(event);
    }
  }).rejects.toThrow(/idle timeout/);

  expect(wsCalled).toBe(1);
  expect(state.isDowngraded).toBe(false);
  expect(downgradeLogged).toBe(false);
  expect(events).toEqual([{ type: 'output_text_delta', delta: 'partial' }]);
});

it('FallbackResponsesModel.getStreamedResponse falls back after exhausting WS retries for pre-stream idle timeout', async () => {
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

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({} as any)) {
    events.push(event);
  }

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled).toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(events).toEqual([{ type: 'response_started' }]);
});

it('Codex getResponse throws ChainingTransportDowngradeError when WS fails on a chained request after exhausting retries', async () => {
  let wsCalled = 0;
  let httpCalled = 0;

  const wsError = new Error('Responses websocket connection closed before opening.');

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw wsError;
    },
  });

  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return { usage: {} as any, output: [] };
    },
  });

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, 'codex', undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  const chainedRequest: ModelRequest = {
    previousResponseId: 'resp_abc',
    input: 'Hello',
    modelSettings: { providerData: { model: 'gpt-5.5-codex' } },
    tools: [],
    handoffs: [],
    tracing: false,
    outputType: {} as any,
  };

  let error: unknown;
  try {
    await model.getResponse(chainedRequest);
  } catch (e: unknown) {
    error = e;
  }
  expect(error instanceof ChainingTransportDowngradeError).toBe(true);
  expect((error as Error).message).toBe('Codex WS connection failed; cannot chain via HTTP');
  expect((error as any).cause).toBe(wsError);
  expect(wsCalled, 'should exhaust WS retries before throwing chaining error').toBe(expectedWsAttempts);
  expect(httpCalled, 'HTTP model should not be called when chaining breaks').toBe(0);
  expect(state.isDowngraded).toBe(true);
});

it('Codex getStreamedResponse throws ChainingTransportDowngradeError when WS fails on a chained request after exhausting retries', async () => {
  let wsCalled = 0;
  let httpCalled = 0;

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
    } as any,
  });

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, 'codex', undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  const chainedRequest: ModelRequest = {
    previousResponseId: 'resp_stream_abc',
    input: 'Hello',
    modelSettings: { providerData: { model: 'gpt-5.5-codex' } },
    tools: [],
    handoffs: [],
    tracing: false,
    outputType: {} as any,
  };

  const events: any[] = [];

  let error: unknown;
  try {
    for await (const event of model.getStreamedResponse(chainedRequest)) {
      events.push(event);
    }
  } catch (e) {
    error = e;
  }

  expect(error instanceof ChainingTransportDowngradeError).toBe(true);
  expect(error.message).toBe('Codex WS connection failed; cannot chain via HTTP');
  expect((error as any).cause).toBe(wsError);
  expect(wsCalled, 'should exhaust WS retries before throwing chaining error').toBe(expectedWsAttempts);
  expect(httpCalled, 'HTTP stream should not be called when chaining breaks').toBe(0);
  expect(state.isDowngraded).toBe(true);
  expect(events).toEqual([]);
});

it('Codex getStreamedResponse still falls back to HTTP when WS fails on a non-chained request', async () => {
  let wsCalled = 0;
  let httpCalled = 0;

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
    } as any,
  });

  const expectedWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, 'codex', undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  // No previousResponseId = not a chained request
  const nonChainedRequest: ModelRequest = {
    input: 'Hello',
    modelSettings: { providerData: { model: 'gpt-5.5-codex' } },
    tools: [],
    handoffs: [],
    tracing: false,
    outputType: {} as any,
  };

  const events: any[] = [];
  for await (const event of model.getStreamedResponse(nonChainedRequest)) {
    events.push(event);
  }

  expect(wsCalled, 'should exhaust WS retries before HTTP fallback').toBe(expectedWsAttempts);
  expect(httpCalled, 'HTTP fallback should still happen for non-chained request').toBe(1);
  expect(state.isDowngraded).toBe(true);
  expect(events).toEqual([{ type: 'response_started' }]);
});

it('FallbackResponsesModel fires state.onDowngrade callback when downgrading', async () => {
  let stateDowngradeFired = false;
  let constructorDowngradeFired = false;

  const wsError = new Error('Responses websocket connection closed before opening.');

  const wsModel = makeMockModel({
    getResponse: async () => {
      throw wsError;
    },
  });

  const httpModel = makeMockModel({
    getResponse: async () => ({ usage: {} as any, output: [] }),
  });

  const state: { isDowngraded: boolean; onDowngrade?: () => void } = {
    isDowngraded: false,
    onDowngrade: () => {
      stateDowngradeFired = true;
    },
  };

  const model = new FallbackResponsesModel(
    wsModel,
    httpModel,
    state,
    () => {
      constructorDowngradeFired = true;
    },
    undefined,
    undefined,
    undefined,
    { sleep: async () => {}, random: () => 0.5 },
  );

  await model.getResponse({} as any);

  expect(state.isDowngraded).toBe(true);
  expect(stateDowngradeFired).toBe(true);
  expect(constructorDowngradeFired).toBe(true);
});

it('FallbackResponsesModel.getResponse succeeds on WS retry without falling back to HTTP', async () => {
  let wsCalled = 0;
  let httpCalled = 0;

  const wsError = new Error('WebSocket first frame timeout after 5000ms');
  const expectedResponse: ModelResponse = { usage: {} as any, output: [] };

  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      if (wsCalled <= 2) {
        throw wsError;
      }
      return expectedResponse;
    },
  });

  const httpModel = makeMockModel({
    getResponse: async () => {
      httpCalled++;
      return { usage: {} as any, output: [] };
    },
  });

  const sleep = createSleepRecorder();
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: sleep.sleep,
    random: () => 0.5,
  });

  const result = await model.getResponse({} as any);

  expect(wsCalled, 'should retry WS and succeed on third attempt').toBe(3);
  expect(httpCalled, 'should not fall back to HTTP when WS retry succeeds').toBe(0);
  expect(state.isDowngraded).toBe(false);
  expect(result).toBe(expectedResponse);
  expect(sleep.delays.length, 'should sleep between WS retries').toBe(2);
});

it('FallbackResponsesModel.getStreamedResponse succeeds on WS retry without falling back to HTTP', async () => {
  let wsCalled = 0;
  let httpCalled = 0;

  const wsError = new Error('WebSocket connection closed before response completed');

  const wsModel = makeMockModel({
    getStreamedResponse: async function* () {
      wsCalled++;
      if (wsCalled <= 1) {
        throw wsError;
      }
      yield { type: 'response_started' } as any;
      yield { type: 'output_text_delta', delta: 'retried' } as any;
    } as any,
  });

  const httpModel = makeMockModel({
    getStreamedResponse: async function* () {
      httpCalled++;
      yield { type: 'output_text_delta', delta: 'fallback' } as any;
    } as any,
  });

  const sleep = createSleepRecorder();
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: sleep.sleep,
    random: () => 0.5,
  });

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({} as any)) {
    events.push(event);
  }

  expect(wsCalled, 'should retry WS and succeed on second attempt').toBe(2);
  expect(httpCalled, 'should not fall back to HTTP when WS retry succeeds').toBe(0);
  expect(state.isDowngraded).toBe(false);
  expect(events).toEqual([{ type: 'response_started' }, { type: 'output_text_delta', delta: 'retried' }]);
  expect(sleep.delays.length, 'should sleep between WS retries').toBe(1);
});

it('FallbackResponsesModel.getResponse uses exponential backoff between WS retries', async () => {
  let wsCalled = 0;

  const wsError = new Error('WebSocket first frame timeout after 5000ms');
  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw wsError;
    },
  });
  const httpModel = makeMockModel({
    getResponse: async () => ({ usage: {} as any, output: [] }),
  });

  const sleep = createSleepRecorder();
  const state = { isDowngraded: false };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: sleep.sleep,
    random: () => 0.5,
  });

  await model.getResponse({} as any);

  expect(sleep.delays.length, 'should sleep between each WS retry').toBe(DEFAULT_STREAM_MAX_RETRIES);
  // With random=0.5 and jitter formula: baseDelay * jitter where jitter = 0.9 + 0.5*0.2 = 1.0
  // attempt 1: min(500 * 2^0, 30000) * 1.0 = 500ms
  // attempt 2: min(500 * 2^1, 30000) * 1.0 = 1000ms
  // attempt 3: min(500 * 2^2, 30000) * 1.0 = 2000ms
  // etc.
  expect(sleep.delays[0], 'first retry delay').toBe(500);
  expect(sleep.delays[1], 'second retry delay').toBe(1000);
  expect(sleep.delays[2], 'third retry delay').toBe(2000);
});

it('FallbackResponsesModel invokes onRetry before each WS retry backoff', async () => {
  let wsCalled = 0;
  let retryCount = 0;

  const wsError = new Error('WebSocket first frame timeout after 5000ms');
  const wsModel = makeMockModel({
    getResponse: async () => {
      wsCalled++;
      throw wsError;
    },
  });
  const httpModel = makeMockModel({
    getResponse: async () => ({ usage: {} as any, output: [] }),
  });

  const state = { isDowngraded: false, onRetry: () => retryCount++ };
  const model = new FallbackResponsesModel(wsModel, httpModel, state, undefined, undefined, undefined, undefined, {
    sleep: async () => {},
    random: () => 0.5,
  });

  await model.getResponse({} as any);

  expect(wsCalled).toBe(DEFAULT_STREAM_MAX_RETRIES + 1);
  expect(retryCount).toBe(DEFAULT_STREAM_MAX_RETRIES);
});
