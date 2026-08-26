import { expect, it, vi } from 'vitest';
import { ResponsesWebSocketSessions } from './responses-websocket-sessions.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class FakeSocket {
  readonly socket: { readyState: number };
  closeCount = 0;
  errorListeners: Array<() => void> = [];

  constructor(readyState = CONNECTING) {
    this.socket = { readyState };
  }

  close(): void {
    this.closeCount += 1;
    this.socket.readyState = CLOSED;
  }

  on(event: string, listener: () => void): void {
    if (event === 'error') this.errorListeners.push(listener);
  }
}

function sessions() {
  const created: FakeSocket[] = [];
  const pool = new ResponsesWebSocketSessions((headers) => {
    const socket = new FakeSocket();
    (socket as FakeSocket & { headers?: Record<string, string> }).headers = headers;
    created.push(socket);
    return socket as never;
  });
  return { pool, created };
}

it('gives concurrent agents distinct sockets and does not close a connecting sibling', () => {
  const { pool, created } = sessions();

  const first = pool.acquire({ 'session-id': 'agent-a', authorization: 'token' }) as unknown as FakeSocket;
  const second = pool.acquire({ 'session-id': 'agent-b', authorization: 'token' }) as unknown as FakeSocket;

  expect(created).toHaveLength(2);
  expect(second).not.toBe(first);
  expect(first.closeCount).toBe(0);
  expect(first.socket.readyState).toBe(CONNECTING);
  expect(second.socket.readyState).toBe(CONNECTING);
});

it('does not reuse a connecting socket while another request is still in flight on it', () => {
  const { pool, created } = sessions();
  const headers = { 'session-id': 'shared', authorization: 'token' };

  const first = pool.acquire(headers) as unknown as FakeSocket;
  const second = pool.acquire(headers) as unknown as FakeSocket;

  expect(created).toHaveLength(2);
  expect(second).not.toBe(first);
  expect(first.closeCount).toBe(0);
});

it('reuses an idle live socket for the next turn of the same agent', () => {
  const { pool, created } = sessions();
  const headers = { 'session-id': 'agent-a', authorization: 'token' };

  const first = pool.acquire(headers) as unknown as FakeSocket;
  first.socket.readyState = OPEN;
  pool.release(first as never, { keepAlive: true });

  const second = pool.acquire({ ...headers, 'x-codex-turn-metadata': '{"turn_id":"2"}' }) as unknown as FakeSocket;

  expect(created).toHaveLength(1);
  expect(second).toBe(first);
  expect(first.closeCount).toBe(0);
});

it('replaces an idle socket when connection headers other than turn metadata change', () => {
  const { pool, created } = sessions();

  const first = pool.acquire({ 'session-id': 'agent-a', authorization: 'old' }) as unknown as FakeSocket;
  first.socket.readyState = OPEN;
  pool.release(first as never, { keepAlive: true });

  const second = pool.acquire({ 'session-id': 'agent-a', authorization: 'new' }) as unknown as FakeSocket;

  expect(created).toHaveLength(2);
  expect(second).not.toBe(first);
  expect(first.closeCount).toBe(1);
});

it('attaches an error listener to every created socket so an idle server-side close cannot crash the process', () => {
  const { pool, created } = sessions();

  pool.acquire({ 'session-id': 'agent-a' });

  expect(created).toHaveLength(1);
  expect(created[0]!.errorListeners.length).toBeGreaterThan(0);
});

it('does not retain an idle socket past the provider connection lifetime cap', () => {
  vi.useFakeTimers();
  try {
    const { pool, created } = sessions();
    const headers = { 'session-id': 'agent-a', authorization: 'token' };

    const first = pool.acquire(headers) as unknown as FakeSocket;
    first.socket.readyState = OPEN;
    pool.release(first as never, { keepAlive: true });
    vi.advanceTimersByTime(61 * 60 * 1000);

    const second = pool.acquire(headers) as unknown as FakeSocket;

    expect(created).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(first.closeCount).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it('still retains a young idle socket for the next turn', () => {
  const { pool, created } = sessions();
  const headers = { 'session-id': 'agent-a', authorization: 'token' };

  const first = pool.acquire(headers) as unknown as FakeSocket;
  first.socket.readyState = OPEN;
  pool.release(first as never, { keepAlive: true });

  const second = pool.acquire(headers) as unknown as FakeSocket;

  expect(created).toHaveLength(1);
  expect(second).toBe(first);
});

it('close() closes every agent socket', () => {
  const { pool, created } = sessions();
  pool.acquire({ 'session-id': 'agent-a' });
  pool.acquire({ 'session-id': 'agent-b' });

  pool.close();

  expect(created).toHaveLength(2);
  expect(created.every((socket) => socket.closeCount === 1)).toBe(true);
});
