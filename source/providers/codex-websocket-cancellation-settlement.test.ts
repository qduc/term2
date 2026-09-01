import { it, expect, vi } from 'vitest';

// The real ResponsesWS opens an actual WebSocket in its constructor. Mock the
// module so this file can drive `.stream()` deterministically, mirroring the
// pattern already used in openai-responses-model.test.ts.
let fakeStream: () => AsyncIterable<any> = async function* () {};
let socketReturnCalls = 0;
vi.mock('openai/resources/responses/ws', () => ({
  ResponsesWS: class {
    socket = { readyState: 1 };
    send() {}
    close() {
      this.socket.readyState = 3;
    }
    stream() {
      return fakeStream();
    }
  },
}));

const { CodexResponsesTransport } = await import('./codex-responses-model.js');

// Bug: cancel_run stayed stuck in "cancelling" forever when the Codex
// WebSocket iterator never settled after AbortSignal fired, because
// CodexResponsesTransport's websocket branch never bound the request's
// signal to the socket message iterator at all — it only reacted to
// message/error/close frames actually emitted by the socket.
it('settles the websocket transport stream when the socket never emits another frame after abort', async () => {
  fakeStream = () => ({
    [Symbol.asyncIterator]() {
      return {
        // Simulates a Codex WebSocket that stops responding mid-turn: the
        // pending receive never resolves on its own.
        next: () => new Promise<IteratorResult<any>>(() => undefined),
        return: async () => {
          socketReturnCalls += 1;
          return { done: true, value: undefined };
        },
      };
    },
  });
  socketReturnCalls = 0;

  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', true);
  const controller = new AbortController();
  const request = { input: [], tools: [], signal: controller.signal } as any;

  const stream = await transport.fetchResponse(request, true, { model: 'gpt-5-codex' });
  const iterator = stream[Symbol.asyncIterator]();
  const pendingNext = iterator.next().then(
    (value: unknown) => ({ kind: 'resolved' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );

  controller.abort();

  const result = await Promise.race([
    pendingNext,
    new Promise<{ kind: 'timed-out' }>((resolve) => setTimeout(() => resolve({ kind: 'timed-out' }), 200)),
  ]);

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect((result.error as Error).name).toBe('AbortError');
  }
  // Cleanup must not await an SDK return that could itself hang on socket
  // closure; it is fired best-effort instead.
  expect(socketReturnCalls).toBeLessThanOrEqual(1);
});

it('leaves an already-completed websocket stream unaffected by a later abort', async () => {
  fakeStream = () => ({
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        next: async () => {
          if (done) return new Promise<IteratorResult<any>>(() => undefined);
          done = true;
          return {
            done: false,
            value: { type: 'message', message: { type: 'response.completed', response: { id: 'resp_ok' } } },
          };
        },
        return: async () => ({ done: true, value: undefined }),
      };
    },
  });

  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', true);
  const controller = new AbortController();
  const request = { input: [], tools: [], signal: controller.signal } as any;

  const stream = await transport.fetchResponse(request, true, { model: 'gpt-5-codex' });
  const iterator = stream[Symbol.asyncIterator]();
  const next = await iterator.next();

  expect(next.done).toBe(false);
  expect(next.value?.type).toBe('response.completed');

  // Aborting after the terminal event was already delivered must not turn a
  // completed response into a spurious cancellation.
  controller.abort();
  expect(next.value?.response?.id).toBe('resp_ok');
});
