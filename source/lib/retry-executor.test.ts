import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { APIConnectionError, RateLimitError } from 'openai';
import { OpenRouterError, OpenAICompatibleError } from '../providers/common/provider-errors.js';
import { executeWithRetry } from './retry-executor.js';

function asInstanceOf<T extends object>(prototype: object, props: Partial<T>): T {
  return Object.assign(Object.create(prototype), props) as T;
}

it('retries transient OpenAI errors with jitter backoff and logs payload', async () => {
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

  expect(result).toBe('ok');
  expect(attempts).toBe(3);
  expect(callbackCount).toBe(2);
  expect(warnLogs.length).toBe(2);
  expect(delays).toEqual([3000, 24000]);
  expect(warnLogs[0]).toEqual({
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
      delayMs: 3000,
      attemptIndex: 0,
      errorMessage: 'temporary network issue',
    },
  });
});

it('uses Retry-After header for rate limit errors', async () => {
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

  expect(delays).toEqual([7000]);
});

it('retries OpenRouter 5xx and includes status in log payload', async () => {
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

  expect(logs.length).toBe(1);
  expect(logs[0].status).toBe(503);
});

it('retries OpenAI-compatible 429 and includes status in log payload', async () => {
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

  expect(logs.length).toBe(1);
  expect(logs[0].status).toBe(429);
  expect(logs[0].delayMs).toBe(1000);
});

it('does not retry non-retryable errors', async () => {
  const error = new Error('bad input');
  let attempts = 0;

  await expect(
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
  ).rejects.toBe(error);
  expect(attempts).toBe(1);
});

it('does not retry retryable errors when retries are exhausted', async () => {
  const error = new OpenRouterError('unavailable', 503, {});
  let attempts = 0;

  await expect(
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
  ).rejects.toBe(error);
  expect(attempts).toBe(1);
});

it('retries generic errors with rate limit status or message', async () => {
  let attempts = 0;
  const logs: Record<string, any>[] = [];

  const result = await executeWithRetry({
    operation: async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("We're currently processing too many requests — please try again later.");
        throw err;
      }
      if (attempts === 2) {
        const err = new Error('Some error');
        (err as any).statusCode = 429;
        throw err;
      }
      if (attempts === 3) {
        const err = new Error('Internal Server Error');
        (err as any).status = 503;
        throw err;
      }
      return 'ok';
    },
    retryAttempts: 3,
    provider: 'generic',
    model: 'generic-model',
    logger: {
      warn: (_message: string, meta?: Record<string, unknown>) => {
        logs.push(meta ?? {});
      },
    },
    sleep: async () => {},
  });

  expect(result).toBe('ok');
  expect(attempts).toBe(4);
  expect(logs.length).toBe(3);
  expect(logs[0].errorMessage).toBe("We're currently processing too many requests — please try again later.");
  expect(logs[1].status).toBe(429);
  expect(logs[2].status).toBe(503);
});

it('uses case-insensitive retry-after header from generic errors', async () => {
  let attempts = 0;
  const delays: number[] = [];

  await executeWithRetry({
    operation: async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('Rate limit');
        (err as any).headers = { 'Retry-After': '12' };
        throw err;
      }
      return 'ok';
    },
    retryAttempts: 1,
    provider: 'generic',
    model: 'generic-model',
    logger: { warn: () => {} },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  expect(attempts).toBe(2);
  expect(delays).toEqual([12000]);
});
