import test from 'ava';
import { OpenAICompatibleError, OpenRouterError } from '../providers/common/provider-errors.js';
import {
  classifyUpstreamRetryableError,
  computeUpstreamRetryDelayMs,
  getRetryAfterMs,
} from './upstream-retry-policy.js';

function asInstanceOf<T extends object>(prototype: object, props: Partial<T>): T {
  return Object.assign(Object.create(prototype), props) as T;
}

test('getRetryAfterMs parses case-insensitive Retry-After from generic Headers-like objects', (t) => {
  const headers = {
    get(name: string) {
      return name.toLowerCase() === 'retry-after' ? '12' : null;
    },
  };

  t.is(getRetryAfterMs({ headers }), 12000);
});

test('getRetryAfterMs ignores invalid Retry-After values', (t) => {
  t.is(getRetryAfterMs({ headers: { 'retry-after': 'not-a-number' } }), undefined);
});

test('classifyUpstreamRetryableError marks OpenRouter and OpenAI-compatible upstream statuses retryable', (t) => {
  const openrouter = classifyUpstreamRetryableError(new OpenRouterError('server error', 503, {}));
  const compatible = classifyUpstreamRetryableError(new OpenAICompatibleError('rate limited', 429, {}));

  t.like(openrouter, {
    retryable: true,
    status: 503,
    reason: 'provider-status',
  });
  t.like(compatible, {
    retryable: true,
    status: 429,
    reason: 'provider-status',
  });
});

test('classifyUpstreamRetryableError marks generic 429/5xx and rate-limit messages retryable', (t) => {
  const err429 = new Error('too many requests');
  (err429 as any).status = 429;

  const err503 = new Error('service unavailable');
  (err503 as any).statusCode = 503;

  t.like(classifyUpstreamRetryableError(err429), {
    retryable: true,
    status: 429,
    reason: 'generic-status',
  });
  t.like(classifyUpstreamRetryableError(err503), {
    retryable: true,
    status: 503,
    reason: 'generic-status',
  });
  t.like(classifyUpstreamRetryableError(new Error('Rate limit exceeded')), {
    retryable: true,
    reason: 'rate-limit-message',
  });
});

test('classifyUpstreamRetryableError keeps non-retryable 400 errors rejected', (t) => {
  t.like(classifyUpstreamRetryableError(new OpenAICompatibleError('bad request', 400, {})), {
    retryable: false,
    status: 400,
    reason: 'provider-status',
  });
});

test('computeUpstreamRetryDelayMs uses Retry-After override before jittered backoff', (t) => {
  t.is(computeUpstreamRetryDelayMs({ retryAfterMs: 7000, attemptIndex: 1, random: () => 0.9 }), 7000);

  let randomIndex = 0;
  const randomValues = [0.4, 0.2, 0.5, 0.8];
  const random = () => {
    const value = randomValues[randomIndex];
    randomIndex += 1;
    return value;
  };

  t.is(computeUpstreamRetryDelayMs({ attemptIndex: 0, random }), 140);
  t.is(computeUpstreamRetryDelayMs({ attemptIndex: 1, random }), 1200);
});

test('computeUpstreamRetryDelayMs uses session attempt numbers for bounded jitter', (t) => {
  let randomIndex = 0;
  const randomValues = [0, 1];
  const random = () => {
    const value = randomValues[randomIndex];
    randomIndex += 1;
    return value;
  };

  t.is(computeUpstreamRetryDelayMs({ attemptNumber: 1, random }), 450);
  t.is(computeUpstreamRetryDelayMs({ attemptNumber: 3, random }), 2200);
});

test('classifyUpstreamRetryableError parses retry-after from generic error headers', (t) => {
  const error = asInstanceOf<Error>(Error.prototype, { message: 'rate limited' });
  (error as any).statusCode = 429;
  (error as any).headers = { 'Retry-After': '7' };

  t.like(classifyUpstreamRetryableError(error), {
    retryable: true,
    status: 429,
    retryAfterMs: 7000,
    reason: 'generic-status',
  });
});
