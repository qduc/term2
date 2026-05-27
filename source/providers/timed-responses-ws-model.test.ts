import test from 'ava';
import { EventEmitter } from 'node:events';
import { TimedResponsesWSModel } from './timed-responses-ws-model.js';
import type { ModelRequest } from '@openai/agents-core';

class MockWebSocket extends EventEmitter {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closeCalls = 0;

  constructor(private readonly openDelayMs = 5) {
    super();
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.emit('open');
    }, this.openDelayMs);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  terminate(): void {
    this.closeCalls++;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

function createMockRequest(input: string): ModelRequest {
  return {
    input,
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  };
}

function createMockClient() {
  return {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
}

test('TimedResponsesWSModel aborts while the websocket is opening', async (t) => {
  const mockWs = new EventEmitter() as any;
  mockWs.readyState = 0;
  mockWs.terminate = () => {
    mockWs.emit('close');
  };
  mockWs.on('error', () => {});

  const mockClient = createMockClient();
  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    () => mockWs,
  );

  const controller = new AbortController();
  const responsePromise = model.getResponse({ ...createMockRequest('Hello'), signal: controller.signal } as any);

  setTimeout(() => {
    controller.abort();
  }, 10);

  await t.throwsAsync(responsePromise, { message: 'Aborted' });
});

test('TimedResponsesWSModel aborts while websocket headers are being prepared', async (t) => {
  const mockWs = new EventEmitter() as any;
  mockWs.readyState = 0;
  mockWs.terminate = () => {
    mockWs.emit('close');
  };
  mockWs.on('error', () => {});

  const mockClient = {
    ...createMockClient(),
    authHeaders: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { Authorization: 'Bearer auth-token' };
    },
  };

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 200, idleTimeoutMs: 5000 },
    () => mockWs,
  );

  const controller = new AbortController();
  const responsePromise = model.getResponse({ ...createMockRequest('Hello'), signal: controller.signal } as any);

  setTimeout(() => {
    controller.abort();
  }, 10);

  await t.throwsAsync(responsePromise, { message: 'Aborted' });
});

test('TimedResponsesWSModel forwards transport overrides into the websocket handshake', async (t) => {
  const mockWs = new MockWebSocket(1);
  const mockClient = {
    ...createMockClient(),
    baseURL: 'https://proxy.example/custom/openai',
    authHeaders: async (args: any) => {
      t.deepEqual(args, {
        method: 'get',
        path: '/custom/openai/responses',
        query: { foo: 'bar' },
      });
      return { Authorization: 'Bearer auth-token' };
    },
  };

  const seenConnections: Array<{ url: string; headers: Record<string, string> }> = [];
  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    (url, options) => {
      seenConnections.push({ url, headers: options.headers });
      return mockWs as any;
    },
  );

  setTimeout(() => {
    mockWs.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_transport' } }));
  }, 10);
  setTimeout(() => {
    mockWs.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_transport',
          output: [],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      }),
    );
  }, 20);

  await model.getResponse({
    ...createMockRequest('Hello'),
    modelSettings: {
      providerData: {
        extraHeaders: {
          'X-Request-Id': 'abc123',
        },
        extraQuery: {
          foo: 'bar',
        },
      },
    },
  } as any);

  t.is(seenConnections.length, 1);
  t.is(seenConnections[0].url, 'wss://proxy.example/custom/openai/responses?foo=bar');
  t.is(seenConnections[0].headers['X-Request-Id'], 'abc123');
  t.is(seenConnections[0].headers.Authorization, 'Bearer auth-token');
});

test('TimedResponsesWSModel keeps the global WebSocket constructor stable during a request', async (t) => {
  const mockWs = new MockWebSocket(1);
  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    () => mockWs as any,
  );

  const installedWebSocket = globalThis.WebSocket;

  setTimeout(() => {
    mockWs.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_global' } }));
  }, 20);
  setTimeout(() => {
    mockWs.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_global',
          output: [],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      }),
    );
  }, 30);

  const responsePromise = model.getResponse(createMockRequest('Hello'));

  await new Promise((resolve) => setTimeout(resolve, 10));
  t.is(globalThis.WebSocket, installedWebSocket);

  await t.notThrowsAsync(responsePromise);
});

test('TimedResponsesWSModel.close closes the active websocket', async (t) => {
  const mockWs = new MockWebSocket();
  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    () => mockWs as any,
  );

  const responsePromise = model.getResponse(createMockRequest('Hello'));

  await new Promise((resolve) => setTimeout(resolve, 10));
  await model.close();

  t.true(mockWs.closeCalls > 0);
  await t.throwsAsync(responsePromise, { message: /WebSocket connection closed before response completed/ });
});

test('TimedResponsesWSModel closes the previous websocket before creating a new one when reuseConnection is false', async (t) => {
  const sockets: MockWebSocket[] = [];
  let secondFactorySawClosedFirst = false;

  const mockClient = createMockClient();
  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000, reuseConnection: false },
    () => {
      const socket = new MockWebSocket(1);
      sockets.push(socket);
      if (sockets.length === 2) {
        secondFactorySawClosedFirst = sockets[0].closeCalls > 0;
      }
      return socket as any;
    },
  );

  setTimeout(() => {
    sockets[0]?.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
  }, 10);
  setTimeout(() => {
    sockets[0]?.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      }),
    );
  }, 20);

  await model.getResponse(createMockRequest('Hello 1'));

  setTimeout(() => {
    sockets[1]?.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_2' } }));
  }, 10);
  setTimeout(() => {
    sockets[1]?.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_2',
          output: [],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      }),
    );
  }, 20);

  await model.getResponse(createMockRequest('Hello 2'));

  t.is(sockets.length, 2);
  t.true(secondFactorySawClosedFirst, 'expected the previous websocket to be closed before opening the next one');
  t.true(sockets[0].closeCalls > 0);
});

test('TimedResponsesWSModel.getResponse sends request and receives response', async (t) => {
  const mockWs = new MockWebSocket();
  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    () => mockWs as any,
  );

  // Schedule response events
  setTimeout(() => {
    mockWs.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
  }, 10);
  setTimeout(() => {
    mockWs.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'test response' }] }],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      }),
    );
  }, 20);

  const result = await model.getResponse(createMockRequest('Hello'));

  t.truthy(result);
  t.is(mockWs.sent.length, 1);
  const sentPayload = JSON.parse(mockWs.sent[0]);
  t.is(sentPayload.type, 'response.create');
  t.is(sentPayload.model, 'gpt-4');
  t.is(sentPayload.stream, true);
  t.deepEqual(sentPayload.input, [{ role: 'user', content: 'Hello' }]);
  t.truthy(result.output);
});

test('TimedResponsesWSModel.getStreamedResponse yields stream events', async (t) => {
  const mockWs = new MockWebSocket();
  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    () => mockWs as any,
  );

  // Schedule response events
  setTimeout(() => {
    mockWs.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_2' } }));
  }, 10);
  setTimeout(() => {
    mockWs.emit(
      'message',
      JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'message', content: [] },
      }),
    );
  }, 20);
  setTimeout(() => {
    mockWs.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_2',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'streamed response' }] }],
          usage: { input_tokens: 15, output_tokens: 25, total_tokens: 40 },
        },
      }),
    );
  }, 30);

  const events: any[] = [];
  for await (const event of model.getStreamedResponse(createMockRequest('Hello'))) {
    events.push(event);
  }

  t.true(events.length > 0);
  t.is(mockWs.sent.length, 1);
});

test('TimedResponsesWSModel respects connect timeout', async (t) => {
  const mockWs = new EventEmitter() as any;
  mockWs.readyState = 0;
  mockWs.terminate = () => {
    mockWs.emit('close');
  };
  mockWs.on('error', () => {});

  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 50, idleTimeoutMs: 5000 },
    () => mockWs,
  );

  await t.throwsAsync(model.getResponse(createMockRequest('Hello')), {
    message: /WebSocket open timed out after 50ms/,
  });
});

test('TimedResponsesWSModel respects idle timeout', async (t) => {
  const mockWs = new MockWebSocket();
  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 50 },
    () => mockWs as any,
  );

  // Don't send any response
  await t.throwsAsync(model.getResponse(createMockRequest('Hello')), { message: /WebSocket idle timeout after 50ms/ });
});

test('TimedResponsesWSModel handles connection close', async (t) => {
  const mockWs = new MockWebSocket();
  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    () => mockWs as any,
  );

  // Close connection before response
  setTimeout(() => {
    mockWs.close();
  }, 10);

  await t.throwsAsync(model.getResponse(createMockRequest('Hello')), { message: /WebSocket connection closed/ });
});

test('TimedResponsesWSModel includes close code and reason in error message', async (t) => {
  const mockWs = new MockWebSocket();
  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    () => mockWs as any,
  );

  setTimeout(() => {
    mockWs.emit('close', 1008, Buffer.from('rate limit exceeded'));
  }, 10);

  await t.throwsAsync(model.getResponse(createMockRequest('Hello')), {
    message: /WebSocket connection closed before response completed.*code=1008.*rate limit exceeded/,
  });
});

test('TimedResponsesWSModel reuses connection for multiple requests', async (t) => {
  const mockWs = new MockWebSocket();
  const mockClient = createMockClient();

  let connectionCount = 0;
  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000, reuseConnection: true },
    () => {
      connectionCount++;
      return mockWs as any;
    },
  );

  // First request
  setTimeout(() => {
    mockWs.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
  }, 10);
  setTimeout(() => {
    mockWs.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      }),
    );
  }, 20);

  await model.getResponse(createMockRequest('Hello 1'));

  // Second request
  setTimeout(() => {
    mockWs.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_2' } }));
  }, 10);
  setTimeout(() => {
    mockWs.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_2',
          output: [],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      }),
    );
  }, 20);

  await model.getResponse(createMockRequest('Hello 2'));

  t.is(connectionCount, 1, 'Should reuse the same connection');
  t.is(mockWs.sent.length, 2, 'Should send two requests');
});

test('TimedResponsesWSModel.getRetryAdvice returns safe retry advice for connection timeouts', (t) => {
  const mockClient = createMockClient();
  const model = new TimedResponsesWSModel(mockClient as any, 'gpt-4', { connectTimeoutMs: 1000, idleTimeoutMs: 5000 });

  const error1 = new Error('Responses websocket connection timed out before opening after 15000ms');
  const advice1 = model.getRetryAdvice({ error: error1 });
  t.true(advice1.suggested);
  t.is(advice1.replaySafety, 'safe');

  const error2 = new Error('WebSocket open timed out after 1000ms');
  const advice2 = model.getRetryAdvice({ error: error2 });
  t.true(advice2.suggested);
  t.is(advice2.replaySafety, 'safe');

  const error3 = new Error('WebSocket idle timeout after 5000ms');
  const advice3 = model.getRetryAdvice({ error: error3 });
  t.false(advice3.suggested);
  t.is(advice3.replaySafety, 'unsafe');

  const error4 = new Error('WebSocket first frame timeout after 5000ms');
  const advice4 = model.getRetryAdvice({ error: error4 });
  t.true(advice4.suggested);
  t.is(advice4.replaySafety, 'safe');
});

test('TimedResponsesWSModel fails fast when no first frame arrives within firstFrameTimeoutMs', async (t) => {
  const mockWs = new MockWebSocket(1);
  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000, firstFrameTimeoutMs: 60 },
    () => mockWs as any,
  );

  await t.throwsAsync(model.getResponse(createMockRequest('Hello')), {
    message: /WebSocket first frame timeout after 60ms/,
  });
});

test('TimedResponsesWSModel uses idleTimeoutMs for mid-stream gaps even when firstFrameTimeoutMs is set', async (t) => {
  const mockWs = new MockWebSocket(1);
  const mockClient = createMockClient();

  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 80, firstFrameTimeoutMs: 30 },
    () => mockWs as any,
  );

  // First frame arrives within firstFrameTimeoutMs.
  setTimeout(() => {
    mockWs.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_x' } }));
  }, 10);

  // Second frame arrives after firstFrameTimeoutMs but within idleTimeoutMs.
  setTimeout(() => {
    mockWs.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_x',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    );
  }, 60);

  const result = await model.getResponse(createMockRequest('Hello'));
  t.truthy(result);
});

test('TimedResponsesWSModel applies firstFrameTimeoutMs to each request on a reused connection', async (t) => {
  const mockWs = new MockWebSocket(1);
  const mockClient = createMockClient();

  let connectionCount = 0;
  const model = new TimedResponsesWSModel(
    mockClient as any,
    'gpt-4',
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000, firstFrameTimeoutMs: 60, reuseConnection: true },
    () => {
      connectionCount++;
      return mockWs as any;
    },
  );

  // First request completes normally.
  setTimeout(() => {
    mockWs.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_a' } }));
  }, 10);
  setTimeout(() => {
    mockWs.emit(
      'message',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_a',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    );
  }, 20);

  await model.getResponse(createMockRequest('Hello 1'));

  // Second request: no response, should hit firstFrameTimeoutMs, not idleTimeoutMs.
  await t.throwsAsync(model.getResponse(createMockRequest('Hello 2')), {
    message: /WebSocket first frame timeout after 60ms/,
  });

  t.is(connectionCount, 1, 'reused connection should be tried before failing');
});
