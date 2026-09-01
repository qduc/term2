import { it, expect } from 'vitest';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';
import { AmbiguousModelOutcomeError } from '../services/retry/retry-errors.js';
import { RetryingModel } from './retrying-model.js';
import { RetryRecoveryBudget, RetryRecoveryBudgetExhaustedError } from '../services/retry/retry-recovery-budget.js';

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

it('stream aborts out of the backoff sleep when the turn signal is aborted', async () => {
  let calls = 0;
  const controller = new AbortController();
  const underlying: StreamedModelTurn = {
    async *stream() {
      calls++;
      throw retryableError();
    },
  };
  // The injected sleep parks without resolving so we can control the abort timing.
  let releaseSleep: (() => void) | undefined;
  const model = new RetryingModel(underlying, {
    retryAttempts: 2,
    sleep: () =>
      new Promise<void>((resolve) => {
        releaseSleep = resolve;
      }),
  });
  const req = { ...request, signal: controller.signal };

  const pending = collect(model.stream(req));
  await new Promise((r) => setTimeout(r, 0));
  // The first attempt failed and the model is now parked in backoff.
  expect(calls).toBe(1);

  // The user interrupts the turn while the backoff is pending.
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  // The wrapped model must not be re-invoked after an abort.
  expect(calls).toBe(1);
  releaseSleep?.();
});

it('stream does not sleep when the signal is already aborted before the backoff', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const underlying: StreamedModelTurn = {
    async *stream() {
      calls++;
      throw retryableError();
    },
  };
  const model = new RetryingModel(underlying, {
    retryAttempts: 2,
    sleep: () => {
      throw new Error('sleep must not be awaited once the signal is already aborted');
    },
  });

  await expect(collect(model.stream({ ...request, signal: controller.signal }))).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(calls).toBe(1);
});

// The typed error carries the triggering provider failure as `cause` and is
// what the session-layer classifier and UI presentation key on. Regressing to
// a bare Error silently drops both the cause chain and the retry_exhausted
// presentation path.
it('stream raises the typed budget-exhausted error, with the triggering failure as cause, once physical attempts are claimed out', async () => {
  let calls = 0;
  const underlying: StreamedModelTurn = {
    async *stream() {
      calls++;
      throw retryableError();
    },
  };
  const budget = new RetryRecoveryBudget({ maxPhysicalAttempts: 1 });
  const model = new RetryingModel(underlying, { retryAttempts: 5, sleep: async () => {} });

  const error = await collect(model.stream({ ...request, recoveryBudget: budget })).catch((e) => e);

  expect(error).toBeInstanceOf(RetryRecoveryBudgetExhaustedError);
  expect((error as RetryRecoveryBudgetExhaustedError).cause).toBeInstanceOf(Error);
  expect((error as Error & { cause?: Error }).cause?.message).toBe('upstream unavailable');
  // One physical dispatch consumed the entire budget; the wrapper must not
  // dispatch a second one it can no longer account for.
  expect(calls).toBe(1);
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
