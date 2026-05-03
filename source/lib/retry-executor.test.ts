import test from 'ava';
import { APIConnectionError, RateLimitError } from 'openai';
import { OpenRouterError } from '../providers/openrouter.js';
import { OpenAICompatibleError } from '../providers/openai-compatible/api.js';
import { executeWithRetry } from './retry-executor.js';

function asInstanceOf<T extends object>(prototype: object, props: Partial<T>): T {
  return Object.assign(Object.create(prototype), props) as T;
}

test('retries transient OpenAI errors with jitter backoff and logs payload', async (t) => {
  const warnLogs: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const delays: number[] = [];
  let callbackCount = 0;
  let attempts = 0;
  const randomValues = [0.4, 0.2, 0.5, 0.8];
  let randomIndex = 0;

  const result = await executeWithRetry({
    operation: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw asInstanceOf<APIConnectionError>(APIConnectionError.prototype, { message: 'temporary network issue' });
      }
      return 'ok';
    },
    retryAttempts: 2,
    provider: 'openai',
    model: 'gpt-test',
    traceId: 'trace-1',
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) => {
        warnLogs.push({ message, meta: meta ?? {} });
      },
    },
    onRetry: () => {
      callbackCount += 1;
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => {
      const value = randomValues[randomIndex];
      randomIndex += 1;
      return value;
    },
  });

  t.is(result, 'ok');
  t.is(attempts, 3);
  t.is(callbackCount, 2);
  t.is(warnLogs.length, 2);
  t.deepEqual(delays, [140, 1200]);
  t.deepEqual(warnLogs[0], {
    message: 'Agent operation retry',
    meta: {
      eventType: 'retry.upstream',
      category: 'retry',
      phase: 'retry',
      traceId: 'trace-1',
      provider: 'openai',
      model: 'gpt-test',
      retryType: 'upstream',
      retryAttempt: 1,
      errorType: 'APIConnectionError',
      retriesRemaining: 1,
      delayMs: 140,
      attemptIndex: 0,
      errorMessage: 'temporary network issue',
    },
  });
});

test('uses Retry-After header for rate limit errors', async (t) => {
  const delays: number[] = [];
  let attempts = 0;
  const error = asInstanceOf<RateLimitError>(RateLimitError.prototype, {
    message: 'rate limited',
  });
  (error as any).headers = { 'retry-after': '7' };

  await executeWithRetry({
    operation: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw error;
      }
      return undefined;
    },
    retryAttempts: 1,
    provider: 'openai',
    model: 'gpt-test',
    logger: { warn: () => {} },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  t.deepEqual(delays, [7000]);
});

test('retries OpenRouter 5xx and includes status in log payload', async (t) => {
  const logs: Record<string, unknown>[] = [];
  let attempts = 0;

  await executeWithRetry({
    operation: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new OpenRouterError('upstream error', 503, {});
      }
      return undefined;
    },
    retryAttempts: 1,
    provider: 'openrouter',
    model: 'test-model',
    logger: {
      warn: (_message: string, meta?: Record<string, unknown>) => {
        logs.push(meta ?? {});
      },
    },
    sleep: async () => {},
    random: () => 0,
  });

  t.is(logs.length, 1);
  t.is(logs[0].status, 503);
});

test('retries OpenAI-compatible 429 and includes status in log payload', async (t) => {
  const logs: Record<string, unknown>[] = [];
  let attempts = 0;

  await executeWithRetry({
    operation: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new OpenAICompatibleError('rate limit', 429, { 'retry-after': '1' });
      }
      return undefined;
    },
    retryAttempts: 1,
    provider: 'openai-compatible',
    model: 'test-model',
    logger: {
      warn: (_message: string, meta?: Record<string, unknown>) => {
        logs.push(meta ?? {});
      },
    },
    sleep: async () => {},
  });

  t.is(logs.length, 1);
  t.is(logs[0].status, 429);
  t.is(logs[0].delayMs, 1000);
});

test('does not retry non-retryable errors', async (t) => {
  const error = new Error('bad input');
  let attempts = 0;

  const thrown = await t.throwsAsync(async () =>
    executeWithRetry({
      operation: async () => {
        attempts += 1;
        throw error;
      },
      retryAttempts: 2,
      provider: 'openai',
      model: 'test-model',
      logger: { warn: () => {} },
      sleep: async () => {},
    }),
  );

  t.is(thrown, error);
  t.is(attempts, 1);
});

test('does not retry retryable errors when retries are exhausted', async (t) => {
  const error = new OpenRouterError('unavailable', 503, {});
  let attempts = 0;

  const thrown = await t.throwsAsync(async () =>
    executeWithRetry({
      operation: async () => {
        attempts += 1;
        throw error;
      },
      retryAttempts: 0,
      provider: 'openrouter',
      model: 'test-model',
      logger: { warn: () => {} },
      sleep: async () => {},
    }),
  );

  t.is(thrown, error);
  t.is(attempts, 1);
});
