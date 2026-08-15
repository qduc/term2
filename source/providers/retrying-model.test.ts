import { it, expect } from 'vitest';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';
import { AmbiguousModelOutcomeError } from '../services/retry/retry-errors.js';
import { RetryingModel } from './retrying-model.js';

const request = { input: [], tools: [] } as StreamedModelTurnRequest;

function retryableError(): Error {
  return Object.assign(new Error('upstream unavailable'), { status: 503 });
}

it('stream retries the same immutable request until exhausted', async () => {
  const seen: StreamedModelTurnRequest[] = [];
  const underlying: StreamedModelTurn = {
    async *stream(seenRequest) {
      seen.push(seenRequest);
      throw retryableError();
    },
  };
  const model = new RetryingModel(underlying, { retryAttempts: 2, sleep: async () => {} });

  await expect(collect(model.stream(request))).rejects.toThrow('upstream unavailable');
  expect(seen.length).toBe(3);
  expect(seen.every((item) => item === request)).toBe(true);
});

it('stream does not replay a request with an ambiguous provider outcome', async () => {
  let calls = 0;
  const underlying: StreamedModelTurn = {
    async *stream() {
      calls++;
      throw new AmbiguousModelOutcomeError('request accepted but response was not acknowledged');
    },
  };
  const model = new RetryingModel(underlying, { retryAttempts: 3, sleep: async () => {} });

  await expect(collect(model.stream(request))).rejects.toThrow('request accepted but response was not acknowledged');
  expect(calls).toBe(1);
});

it('stream fails immediately for non-retryable errors', async () => {
  let calls = 0;
  const underlying: StreamedModelTurn = {
    async *stream() {
      calls++;
      throw new Error('invalid request');
    },
  };
  const model = new RetryingModel(underlying, { retryAttempts: 3, sleep: async () => {} });

  await expect(collect(model.stream(request))).rejects.toThrow('invalid request');
  expect(calls).toBe(1);
});

it('stream retries only before the first event', async () => {
  let calls = 0;
  const event = { type: 'text_delta', text: 'ok' } as const;
  const underlying: StreamedModelTurn = {
    async *stream(seenRequest) {
      expect(seenRequest).toBe(request);
      calls++;
      if (calls === 1) throw retryableError();
      yield event;
    },
  };
  const model = new RetryingModel(underlying, { retryAttempts: 2, sleep: async () => {} });

  expect(await collect(model.stream(request))).toEqual([event]);
  expect(calls).toBe(2);
});

it('stream does not retry after an event commits', async () => {
  let calls = 0;
  const event = { type: 'text_delta', text: 'ok' } as const;
  const underlying: StreamedModelTurn = {
    async *stream() {
      calls++;
      yield event;
      throw retryableError();
    },
  };
  const model = new RetryingModel(underlying, { retryAttempts: 2, sleep: async () => {} });

  const iterator = model.stream(request)[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ done: false, value: event });

  await expect(iterator.next()).rejects.toThrow('upstream unavailable');
  expect(calls).toBe(1);
});

it('stream uses the larger upstream backoff schedule for retries', async () => {
  const delays: number[] = [];
  let calls = 0;
  const randomValues = [0.4, 0.2, 0.5, 0.8];
  let randomIndex = 0;
  const underlying: StreamedModelTurn = {
    async *stream() {
      calls++;
      throw retryableError();
    },
  };
  const model = new RetryingModel(underlying, {
    retryAttempts: 2,
    sleep: async (delayMs: number) => {
      delays.push(delayMs);
    },
    random: () => {
      const value = randomValues[randomIndex];
      randomIndex += 1;
      return value;
    },
  });

  await expect(collect(model.stream(request))).rejects.toThrow('upstream unavailable');
  expect(calls).toBe(3);
  expect(delays).toEqual([3000, 24000]);
});

it('RetryingModel does not expose getResponse when the wrapped model has none', () => {
  const inner: StreamedModelTurn = {
    async *stream() {},
  };
  expect(inner).not.toHaveProperty('getResponse');
  const wrapper = new RetryingModel(inner, { retryAttempts: 0, sleep: async () => {} });
  expect(wrapper).not.toHaveProperty('getResponse');
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
