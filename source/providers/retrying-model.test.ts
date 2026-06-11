import test from 'ava';
import type { Model, ModelRequest, StreamEvent } from '@openai/agents-core';
import { RetryingModel } from './retrying-model.js';

const request = { input: 'hello' } as unknown as ModelRequest;

function retryableError(): Error {
  return Object.assign(new Error('upstream unavailable'), { status: 503 });
}

test('getResponse retries the same request on the same model until exhausted', async (t) => {
  const seen: ModelRequest[] = [];
  const underlying = {
    async getResponse(seenRequest: ModelRequest) {
      seen.push(seenRequest);
      throw retryableError();
    },
    async *getStreamedResponse() {},
  } as unknown as Model;
  const model = new RetryingModel(underlying, { retryAttempts: 2, sleep: async () => {} });

  await t.throwsAsync(() => model.getResponse(request), { message: 'upstream unavailable' });
  t.is(seen.length, 3);
  t.true(seen.every((item) => item === request));
});

test('getResponse fails immediately for non-retryable errors', async (t) => {
  let calls = 0;
  const underlying = {
    async getResponse() {
      calls++;
      throw new Error('invalid request');
    },
    async *getStreamedResponse() {},
  } as unknown as Model;
  const model = new RetryingModel(underlying, { retryAttempts: 3, sleep: async () => {} });

  await t.throwsAsync(() => model.getResponse(request), { message: 'invalid request' });
  t.is(calls, 1);
});

test('getStreamedResponse retries only before the first event', async (t) => {
  let calls = 0;
  const event = { type: 'response_started' } as unknown as StreamEvent;
  const underlying = {
    async getResponse() {
      throw new Error('unused');
    },
    async *getStreamedResponse(seenRequest: ModelRequest) {
      t.is(seenRequest, request);
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
  t.deepEqual(events, [event]);
  t.is(calls, 2);
});

test('getStreamedResponse does not retry after an event commits', async (t) => {
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
  t.deepEqual(await iterator.next(), { done: false, value: event });
  await t.throwsAsync(() => iterator.next(), { message: 'upstream unavailable' });
  t.is(calls, 1);
});
