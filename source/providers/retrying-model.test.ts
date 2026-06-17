import { it, expect } from 'vitest';
import type { Model, ModelRequest, StreamEvent } from '@openai/agents-core';
import { RetryingModel } from './retrying-model.js';

const request = { input: 'hello' } as unknown as ModelRequest;

function retryableError(): Error {
  return Object.assign(new Error('upstream unavailable'), { status: 503 });
}

it('getResponse retries the same request on the same model until exhausted', async () => {
  const seen: ModelRequest[] = [];
  const underlying = {
    async getResponse(seenRequest: ModelRequest) {
      seen.push(seenRequest);
      throw retryableError();
    },
    async *getStreamedResponse() {},
  } as unknown as Model;
  const model = new RetryingModel(underlying, { retryAttempts: 2, sleep: async () => {} });

  await expect(model.getResponse(request)).rejects.toThrow('upstream unavailable');
  expect(seen.length).toBe(3);
  expect(seen.every((item) => item === request)).toBe(true);
});

it('getResponse fails immediately for non-retryable errors', async () => {
  let calls = 0;
  const underlying = {
    async getResponse() {
      calls++;
      throw new Error('invalid request');
    },
    async *getStreamedResponse() {},
  } as unknown as Model;
  const model = new RetryingModel(underlying, { retryAttempts: 3, sleep: async () => {} });

  await expect(model.getResponse(request)).rejects.toThrow('invalid request');
  expect(calls).toBe(1);
});

it('getStreamedResponse retries only before the first event', async () => {
  let calls = 0;
  const event = { type: 'response_started' } as unknown as StreamEvent;
  const underlying = {
    async getResponse() {
      throw new Error('unused');
    },
    async *getStreamedResponse(seenRequest: ModelRequest) {
      expect(seenRequest).toBe(request);
      calls++;
      if (calls === 1) throw retryableError();
      yield event;
    },
  } as unknown as Model;
  const model = new RetryingModel(underlying, { retryAttempts: 2, sleep: async () => {} });

  const events: StreamEvent[] = [];
  for await (const streamedEvent of model.getStreamedResponse(request)) {
    events.push(streamedEvent);
  }
  expect(events).toEqual([event]);
  expect(calls).toBe(2);
});

it('getStreamedResponse does not retry after an event commits', async () => {
  let calls = 0;
  const event = { type: 'response_started' } as unknown as StreamEvent;
  const underlying = {
    async getResponse() {
      throw new Error('unused');
    },
    async *getStreamedResponse() {
      calls++;
      yield event;
      throw retryableError();
    },
  } as unknown as Model;
  const model = new RetryingModel(underlying, { retryAttempts: 2, sleep: async () => {} });

  const iterator = model.getStreamedResponse(request)[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ done: false, value: event });

  await expect(iterator.next()).rejects.toThrow('upstream unavailable');
  expect(calls).toBe(1);
});

it('getResponse uses the larger upstream backoff schedule for retries', async () => {
  const delays: number[] = [];
  let calls = 0;
  const randomValues = [0.4, 0.2, 0.5, 0.8];
  let randomIndex = 0;
  const underlying = {
    async getResponse() {
      calls++;
      throw retryableError();
    },
    async *getStreamedResponse() {},
  } as unknown as Model;
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

  await expect(model.getResponse(request)).rejects.toThrow('upstream unavailable');
  expect(calls).toBe(3);
  expect(delays).toEqual([3000, 24000]);
});
