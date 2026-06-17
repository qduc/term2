import { it, expect } from 'vitest';
import { RateLimitError } from 'openai';
import { OpenAICompatibleError, OpenRouterError, LongRetryDelayError } from '../../providers/common/provider-errors.js';
import {
  classifyUpstreamRetryableError,
  computeUpstreamRetryDelayMs,
  getRetryAfterMs,
} from './upstream-retry-policy.js';

function asInstanceOf<T extends object>(prototype: object, props: Partial<T>): T {
  return Object.assign(Object.create(prototype), props) as T;
}

it('getRetryAfterMs parses case-insensitive Retry-After from generic Headers-like objects', () => {
  const headers = {
    get(name: string) {
      return name.toLowerCase() === 'retry-after' ? '12' : null;
    },
  };

  expect(getRetryAfterMs({ headers })).toBe(12000);
});

it('getRetryAfterMs ignores invalid Retry-After values', () => {
  expect(getRetryAfterMs({ headers: { 'retry-after': 'not-a-number' } })).toBe(undefined);
});

it('classifyUpstreamRetryableError marks OpenRouter and OpenAI-compatible upstream statuses retryable', () => {
  const openrouter = classifyUpstreamRetryableError(new OpenRouterError('server error', 503, {}));
  const compatible = classifyUpstreamRetryableError(new OpenAICompatibleError('rate limited', 429, {}));

  expect(openrouter).toMatchObject({
    retryable: true,
    status: 503,
    reason: 'provider-status',
  });
  expect(compatible).toMatchObject({
    retryable: true,
    status: 429,
    reason: 'provider-status',
  });
});

it('classifyUpstreamRetryableError marks generic 429/5xx and rate-limit messages retryable', () => {
  const err429 = new Error('too many requests');
  (err429 as any).status = 429;

  const err503 = new Error('service unavailable');
  (err503 as any).statusCode = 503;

  expect(classifyUpstreamRetryableError(err429)).toMatchObject({
    retryable: true,
    status: 429,
    reason: 'generic-status',
  });
  expect(classifyUpstreamRetryableError(err503)).toMatchObject({
    retryable: true,
    status: 503,
    reason: 'generic-status',
  });
  expect(classifyUpstreamRetryableError(new Error('Rate limit exceeded'))).toMatchObject({
    retryable: true,
    reason: 'rate-limit-message',
  });
});

it('classifyUpstreamRetryableError keeps non-retryable 400 errors rejected', () => {
  expect(classifyUpstreamRetryableError(new OpenAICompatibleError('bad request', 400, {}))).toMatchObject({
    retryable: false,
    status: 400,
    reason: 'provider-status',
  });
});

it('computeUpstreamRetryDelayMs uses Retry-After override before jittered backoff', () => {
  expect(computeUpstreamRetryDelayMs({ retryAfterMs: 7000, attemptIndex: 1, random: () => 0.9 })).toBe(7000);

  let randomIndex = 0;
  const randomValues = [0.4, 0.2, 0.5, 0.8];
  const random = () => {
    const value = randomValues[randomIndex];
    randomIndex += 1;
    return value;
  };

  expect(computeUpstreamRetryDelayMs({ attemptIndex: 0, random })).toBe(3000);
  expect(computeUpstreamRetryDelayMs({ attemptIndex: 1, random })).toBe(24000);
});

it('computeUpstreamRetryDelayMs uses session attempt numbers for bounded jitter', () => {
  let randomIndex = 0;
  const randomValues = [0, 1];
  const random = () => {
    const value = randomValues[randomIndex];
    randomIndex += 1;
    return value;
  };

  expect(computeUpstreamRetryDelayMs({ attemptNumber: 1, random })).toBe(450);
  expect(computeUpstreamRetryDelayMs({ attemptNumber: 3, random })).toBe(2200);
});

it('classifyUpstreamRetryableError marks RateLimitExceededError non-retryable', () => {
  expect(classifyUpstreamRetryableError(new LongRetryDelayError(120))).toMatchObject({
    retryable: false,
    reason: 'long-retry-delay',
  });
  expect(classifyUpstreamRetryableError(new LongRetryDelayError(300))).toMatchObject({
    retryable: false,
    reason: 'long-retry-delay',
  });
});

it('classifyUpstreamRetryableError marks RateLimitError with retry-after > 60s non-retryable', () => {
  const err = new RateLimitError(429, 'rate limited', 'rate limited', { get: () => '120' } as any);
  expect(classifyUpstreamRetryableError(err)).toMatchObject({
    retryable: false,
    reason: 'long-retry-delay',
  });
});

it('classifyUpstreamRetryableError marks RateLimitError with retry-after <= 60s retryable', () => {
  const err = new RateLimitError(429, 'rate limited', 'rate limited', { get: () => '30' } as any);
  expect(classifyUpstreamRetryableError(err)).toMatchObject({
    retryable: true,
    reason: 'openai-sdk',
  });
});

it('classifyUpstreamRetryableError marks RateLimitError without retry-after retryable', () => {
  const err = new RateLimitError(429, 'rate limited', 'rate limited', { get: () => null } as any);
  expect(classifyUpstreamRetryableError(err)).toMatchObject({
    retryable: true,
    reason: 'openai-sdk',
  });
});

it('classifyUpstreamRetryableError parses retry-after from generic error headers', () => {
  const error = asInstanceOf<Error>(Error.prototype, { message: 'rate limited' });
  (error as any).statusCode = 429;
  (error as any).headers = { 'Retry-After': '7' };

  expect(classifyUpstreamRetryableError(error)).toMatchObject({
    retryable: true,
    status: 429,
    retryAfterMs: 7000,
    reason: 'generic-status',
  });
});
