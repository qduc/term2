import test from 'ava';
import { TimedWsConnection } from './timed-ws-connection.js';
import { EventEmitter } from 'node:events';

class MockWebSocket extends EventEmitter {
  readyState = 0; // CONNECTING
  private terminated = false;

  constructor(_url: string, _options?: any) {
    super();
    // Simulate async connection
    setTimeout(() => {
      if (!this.terminated) {
        this.readyState = 1; // OPEN
        this.emit('open');
      }
    }, 10);
  }

  send(_data: string): void {
    if (this.readyState !== 1) {
      throw new Error('WebSocket is not open');
    }
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

test('TimedWsConnection.connect succeeds when open event arrives', async (t) => {
  const mockWs = new MockWebSocket('ws://test.com', {});
  const wsFactory = () => mockWs as any;

  const connection = await TimedWsConnection.connect(
    'ws://test.com',
    { Authorization: 'Bearer test' },
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    undefined,
    wsFactory,
  );

  t.truthy(connection);
});

test('TimedWsConnection.connect times out when open never arrives', async (t) => {
  const mockWs = new EventEmitter() as any;
  mockWs.readyState = 0;
  mockWs.terminate = () => {
    mockWs.emit('close');
  };
  // Prevent uncaught exception after our listener is removed
  mockWs.on('error', () => {});

  // Never emit 'open'
  const wsFactory = () => mockWs;

  await t.throwsAsync(
    TimedWsConnection.connect(
      'ws://test.com',
      {},
      { connectTimeoutMs: 100, idleTimeoutMs: 5000 },
      undefined,
      wsFactory,
    ),
    { message: /WebSocket open timed out after 100ms/ },
  );
});

test('TimedWsConnection.nextFrame resolves when message arrives', async (t) => {
  const mockWs = new MockWebSocket('ws://test.com', {});
  const wsFactory = () => mockWs as any;

  const connection = await TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    undefined,
    wsFactory,
  );

  // Schedule a message
  setTimeout(() => {
    mockWs.emit('message', 'test message');
  }, 10);

  const frame = await connection.nextFrame();
  t.is(frame, 'test message');
});

test('TimedWsConnection.nextFrame times out when no message arrives', async (t) => {
  const mockWs = new MockWebSocket('ws://test.com', {});
  const wsFactory = () => mockWs as any;

  const connection = await TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 100 },
    undefined,
    wsFactory,
  );

  // Don't emit any message
  await t.throwsAsync(connection.nextFrame(), { message: /WebSocket idle timeout after 100ms/ });
});

test('TimedWsConnection.nextFrame idle timeout resets on each message', async (t) => {
  const mockWs = new MockWebSocket('ws://test.com', {});
  const wsFactory = () => mockWs as any;

  const connection = await TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 150 },
    undefined,
    wsFactory,
  );

  // First message
  setTimeout(() => {
    mockWs.emit('message', 'message 1');
  }, 50);

  const frame1 = await connection.nextFrame();
  t.is(frame1, 'message 1');

  // Second message after 100ms (within idle timeout)
  setTimeout(() => {
    mockWs.emit('message', 'message 2');
  }, 100);

  const frame2 = await connection.nextFrame();
  t.is(frame2, 'message 2');

  // Third message after another 100ms (still within idle timeout from last message)
  setTimeout(() => {
    mockWs.emit('message', 'message 3');
  }, 100);

  const frame3 = await connection.nextFrame();
  t.is(frame3, 'message 3');
});

test('TimedWsConnection.nextFrame returns null when connection closes', async (t) => {
  const mockWs = new MockWebSocket('ws://test.com', {});
  const wsFactory = () => mockWs as any;

  const connection = await TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    undefined,
    wsFactory,
  );

  // Close the connection
  setTimeout(() => {
    mockWs.emit('close');
  }, 10);

  const frame = await connection.nextFrame();
  t.is(frame, null);
});

test('TimedWsConnection.nextFrame timeout override fires before idleTimeoutMs', async (t) => {
  const mockWs = new MockWebSocket('ws://test.com', {});
  const wsFactory = () => mockWs as any;

  const connection = await TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    undefined,
    wsFactory,
  );

  await t.throwsAsync(
    connection.nextFrame(undefined, { timeoutMs: 50, timeoutErrorMessage: 'first frame timed out' }),
    { message: 'first frame timed out' },
  );
});

test('TimedWsConnection.nextFrame timeout override falls back to idleTimeoutMs when omitted', async (t) => {
  const mockWs = new MockWebSocket('ws://test.com', {});
  const wsFactory = () => mockWs as any;

  const connection = await TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 75 },
    undefined,
    wsFactory,
  );

  await t.throwsAsync(connection.nextFrame(undefined, undefined), {
    message: /WebSocket idle timeout after 75ms/,
  });
});

test('TimedWsConnection.connect handles error event', async (t) => {
  const mockWs = new EventEmitter() as any;
  mockWs.readyState = 0;
  mockWs.terminate = () => {
    mockWs.emit('close');
  };
  // Prevent uncaught exception after our listener is removed
  mockWs.on('error', () => {});

  const wsFactory = () => mockWs;

  const connectionPromise = TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    undefined,
    wsFactory,
  );

  setTimeout(() => {
    mockWs.emit('error', new Error('Connection refused'));
  }, 10);

  await t.throwsAsync(connectionPromise, { message: 'Connection refused' });
});

test('TimedWsConnection.connect handles close before open', async (t) => {
  const mockWs = new EventEmitter() as any;
  mockWs.readyState = 0;
  mockWs.terminate = () => {
    mockWs.emit('close');
  };
  mockWs.on('error', () => {});

  const wsFactory = () => mockWs;

  const connectionPromise = TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    undefined,
    wsFactory,
  );

  setTimeout(() => {
    mockWs.emit('close');
  }, 10);

  await t.throwsAsync(connectionPromise, { message: 'WebSocket closed before opening' });
});

test('TimedWsConnection.connect rejects immediately when the signal is already aborted', async (t) => {
  const controller = new AbortController();
  controller.abort();

  let wsFactoryCalled = false;

  await t.throwsAsync(
    TimedWsConnection.connect(
      'ws://test.com',
      {},
      { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
      controller.signal,
      () => {
        wsFactoryCalled = true;
        throw new Error('wsFactory should not be called for an already-aborted signal');
      },
    ),
    { message: 'Aborted' },
  );

  t.false(wsFactoryCalled);
});

test('TimedWsConnection respects abort signal during connect', async (t) => {
  const mockWs = new EventEmitter() as any;
  mockWs.readyState = 0;
  mockWs.terminate = () => {
    mockWs.emit('close');
  };
  mockWs.on('error', () => {});

  const wsFactory = () => mockWs;

  const controller = new AbortController();
  const connectionPromise = TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    controller.signal,
    wsFactory,
  );

  setTimeout(() => {
    controller.abort();
  }, 10);

  await t.throwsAsync(connectionPromise, { message: 'Aborted' });
});

test('TimedWsConnection.send forwards data to underlying socket', async (t) => {
  const mockWs = new MockWebSocket('ws://test.com', {});
  const sent: string[] = [];
  mockWs.send = (data: string) => {
    sent.push(data);
  };

  const wsFactory = () => mockWs as any;

  const connection = await TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    undefined,
    wsFactory,
  );

  connection.send('test data');
  t.deepEqual(sent, ['test data']);
});

test('TimedWsConnection.close closes underlying socket', async (t) => {
  const mockWs = new MockWebSocket('ws://test.com', {});
  let closed = false;
  const originalClose = mockWs.close.bind(mockWs);
  mockWs.close = () => {
    closed = true;
    originalClose();
  };

  const wsFactory = () => mockWs as any;

  const connection = await TimedWsConnection.connect(
    'ws://test.com',
    {},
    { connectTimeoutMs: 1000, idleTimeoutMs: 5000 },
    undefined,
    wsFactory,
  );

  await connection.close();
  t.true(closed);
});
