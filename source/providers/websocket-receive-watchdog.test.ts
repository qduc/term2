import { expect, it, vi } from 'vitest';
import { createWebSocketReceiveWatchdog } from './websocket-receive-watchdog.js';

it('starts the first-frame deadline when consumption begins, not when the watchdog is constructed', async () => {
  vi.useFakeTimers();
  const watchdog = createWebSocketReceiveWatchdog(undefined, { firstFrameMs: 10, interFrameMs: 20 });
  const raw = {
    next: () => Promise.resolve({ done: false, value: { type: 'response.created' } }),
    return: async () => ({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  const iterator = watchdog.wrap(raw)[Symbol.asyncIterator]();
  await vi.advanceTimersByTimeAsync(10);

  expect(watchdog.signal.aborted).toBe(false);
  await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'response.created' } });
  vi.useRealTimers();
});

it('turns a first-frame receive stall into a first-frame timeout and closes the raw iterator', async () => {
  vi.useFakeTimers();
  const watchdog = createWebSocketReceiveWatchdog(undefined, { firstFrameMs: 10, interFrameMs: 20 });
  let returnCalled = false;
  const raw = {
    next: () =>
      new Promise<IteratorResult<unknown>>((_, reject) => {
        watchdog.signal.addEventListener('abort', () => reject(watchdog.signal.reason), { once: true });
      }),
    return: async () => {
      returnCalled = true;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const received = watchdog.wrap(raw);

  const result = received[Symbol.asyncIterator]().next();
  const rejection = expect(result).rejects.toThrow('WebSocket first frame timeout');
  await vi.advanceTimersByTimeAsync(10);

  await rejection;
  expect(watchdog.signal.aborted).toBe(true);
  expect(returnCalled).toBe(true);
  vi.useRealTimers();
});

it('propagates a timeout when raw iterator cleanup never resolves', async () => {
  vi.useFakeTimers();
  const watchdog = createWebSocketReceiveWatchdog(undefined, { firstFrameMs: 10, interFrameMs: 20 });
  let returnCalled = false;
  const raw = {
    next: () =>
      new Promise<IteratorResult<unknown>>((_, reject) => {
        watchdog.signal.addEventListener('abort', () => reject(watchdog.signal.reason), { once: true });
      }),
    return: () => {
      returnCalled = true;
      return new Promise<IteratorResult<unknown>>(() => {});
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  const result = watchdog.wrap(raw)[Symbol.asyncIterator]().next();
  const rejection = expect(result).rejects.toThrow('WebSocket first frame timeout');
  await vi.advanceTimersByTimeAsync(10);

  await rejection;
  expect(returnCalled).toBe(true);
  vi.useRealTimers();
});

it('preserves the stream error when raw iterator cleanup rejects', async () => {
  const watchdog = createWebSocketReceiveWatchdog(undefined, { firstFrameMs: 10, interFrameMs: 20 });
  const streamError = new Error('stream failed');
  const cleanupError = new Error('cleanup failed');
  const raw = {
    next: () => Promise.reject(streamError),
    return: () => Promise.reject(cleanupError),
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  await expect(watchdog.wrap(raw)[Symbol.asyncIterator]().next()).rejects.toBe(streamError);
  await Promise.resolve();
});

it('resets its deadline for every raw event and reports an idle timeout', async () => {
  vi.useFakeTimers();
  const watchdog = createWebSocketReceiveWatchdog(undefined, { firstFrameMs: 10, interFrameMs: 20 });
  let reads = 0;
  const raw = {
    next: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve({ done: false, value: { type: 'response.created' } });
      return new Promise<IteratorResult<unknown>>((_, reject) => {
        watchdog.signal.addEventListener('abort', () => reject(watchdog.signal.reason), { once: true });
      });
    },
    return: async () => ({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const iterator = watchdog.wrap(raw)[Symbol.asyncIterator]();

  await vi.advanceTimersByTimeAsync(9);
  await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'response.created' } });
  const stalledRead = iterator.next();
  const rejection = expect(stalledRead).rejects.toThrow('WebSocket idle timeout');
  await vi.advanceTimersByTimeAsync(19);
  expect(watchdog.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejection;
  vi.useRealTimers();
});

it('preserves an external abort instead of rewriting it as a timeout', async () => {
  vi.useFakeTimers();
  const external = new AbortController();
  const watchdog = createWebSocketReceiveWatchdog(external.signal, { firstFrameMs: 10, interFrameMs: 20 });
  const abortReason = new Error('user cancelled');
  const raw = {
    next: () =>
      new Promise<IteratorResult<unknown>>((_, reject) => {
        watchdog.signal.addEventListener('abort', () => reject(watchdog.signal.reason), { once: true });
      }),
    return: async () => ({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const result = watchdog.wrap(raw)[Symbol.asyncIterator]().next();
  const rejection = expect(result).rejects.toBe(abortReason);

  external.abort(abortReason);

  await rejection;
  expect(watchdog.timeoutError()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(100);
  vi.useRealTimers();
});
