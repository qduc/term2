import test from 'ava';
import { ModelBehaviorError } from '@openai/agents';
import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenRouterError, OpenAICompatibleError } from '../providers/common/provider-errors.js';
import {
  decideRetry,
  isRecoverableModelError,
  isTransientRetryableError,
  MAX_HALLUCINATION_RETRIES,
} from './conversation-retry-policy.js';

test('isRecoverableModelError: non-ModelBehaviorError returns false', (t) => {
  t.false(isRecoverableModelError(new Error('boom')));
  t.false(isRecoverableModelError('boom'));
  t.false(isRecoverableModelError(null));
});

test('isRecoverableModelError: hallucination message returns true', (t) => {
  t.true(isRecoverableModelError(new ModelBehaviorError('Tool fake_tool not found')));
});

test('isRecoverableModelError: parsing tool arguments returns true', (t) => {
  t.true(isRecoverableModelError(new ModelBehaviorError('Error parsing tool arguments')));
});

test('isRecoverableModelError: valid json returns true', (t) => {
  t.true(isRecoverableModelError(new ModelBehaviorError('arguments must be valid json')));
});

test('isRecoverableModelError: model did not produce a final response returns true', (t) => {
  t.true(isRecoverableModelError(new ModelBehaviorError('Model did not produce a final response')));
});

test('isRecoverableModelError: unrelated ModelBehaviorError returns false', (t) => {
  t.false(isRecoverableModelError(new ModelBehaviorError('something else')));
});

test('decideRetry: non-recoverable error returns no_retry', (t) => {
  const decision = decideRetry(new Error('boom'), 0, true, 0);
  t.is(decision.kind, 'no_retry');
});

test('decideRetry: at MAX attempts returns no_retry', (t) => {
  const decision = decideRetry(new ModelBehaviorError('Tool x not found'), MAX_HALLUCINATION_RETRIES, true, 0);
  t.is(decision.kind, 'no_retry');
});

test('decideRetry: hallucination at attempt 0 returns retry with tool name extracted', (t) => {
  const decision = decideRetry(new ModelBehaviorError('Tool fake_tool not found'), 0, true, 5);
  t.is(decision.kind, 'retry');
  if (decision.kind !== 'retry') return;
  t.is(decision.retryEvent.toolName, 'fake_tool');
  t.is(decision.retryEvent.attempt, 1);
  t.is(decision.logPayload.retryType, 'hallucination');
  t.is(decision.logPayload.toolName, 'fake_tool');
  t.true(decision.hadStream);
  t.false(decision.shouldInjectErrorContext);
  t.deepEqual(decision.nextRunOptions, { hallucinationRetryCount: 1, skipUserMessage: true });
});

test('decideRetry: parsing error returns retry with toolName=model and parsing_error type', (t) => {
  const decision = decideRetry(new ModelBehaviorError('Error parsing tool arguments'), 0, true, 0);
  t.is(decision.kind, 'retry');
  if (decision.kind !== 'retry') return;
  t.is(decision.retryEvent.toolName, 'model');
  t.is(decision.logPayload.retryType, 'parsing_error');
  t.is(decision.logPayload.toolName, 'unknown');
});

test('decideRetry: behavior (model did not produce) returns retry with behavior type', (t) => {
  const decision = decideRetry(new ModelBehaviorError('Model did not produce a final response'), 1, true, 3);
  t.is(decision.kind, 'retry');
  if (decision.kind !== 'retry') return;
  t.is(decision.logPayload.retryType, 'behavior');
  t.is(decision.attempt, 2);
});

test('decideRetry: with stream and empty history sets shouldInjectErrorContext', (t) => {
  const decision = decideRetry(new ModelBehaviorError('Tool x not found'), 0, true, 0);
  t.is(decision.kind, 'retry');
  if (decision.kind !== 'retry') return;
  t.true(decision.shouldInjectErrorContext);
  t.true(decision.errorContextMessage.includes('Previous attempt failed'));
});

test('decideRetry: without stream returns retry with skipUserMessage=false', async (t) => {
  const decision = decideRetry(new ModelBehaviorError('Tool x not found'), 0, false, 0);
  t.is(decision.kind, 'retry');
  if (decision.kind !== 'retry') return;
  t.false(decision.hadStream);
  t.false(decision.shouldInjectErrorContext);
  t.deepEqual(decision.nextRunOptions, { hallucinationRetryCount: 1, skipUserMessage: false });
});

function asInstanceOf<T extends object>(prototype: object, props: Partial<T>): T {
  return Object.assign(Object.create(prototype), props) as T;
}

test('isTransientRetryableError: OpenAI SDK errors are retryable', (t) => {
  t.true(isTransientRetryableError(asInstanceOf(APIConnectionError.prototype, { message: 'conn error' })));
  t.true(isTransientRetryableError(asInstanceOf(APIConnectionTimeoutError.prototype, { message: 'timeout' })));
  t.true(isTransientRetryableError(asInstanceOf(InternalServerError.prototype, { message: 'ise', status: 500 })));
  t.true(isTransientRetryableError(asInstanceOf(RateLimitError.prototype, { message: 'rate limit', status: 429 })));
});

test('isTransientRetryableError: OpenRouter 429/5xx are retryable', (t) => {
  t.true(isTransientRetryableError(new OpenRouterError('rate limited', 429, {})));
  t.true(isTransientRetryableError(new OpenRouterError('server error', 500, {})));
  t.true(isTransientRetryableError(new OpenRouterError('bad gateway', 502, {})));
  t.false(isTransientRetryableError(new OpenRouterError('not found', 404, {})));
});

test('isTransientRetryableError: OpenAI-compatible 429/5xx are retryable', (t) => {
  t.true(isTransientRetryableError(new OpenAICompatibleError('rate limited', 429, {})));
  t.true(isTransientRetryableError(new OpenAICompatibleError('server error', 503, {})));
  t.false(isTransientRetryableError(new OpenAICompatibleError('bad request', 400, {})));
});

test('isTransientRetryableError: generic errors with 429/5xx status are retryable', (t) => {
  const err429 = new Error('too many requests');
  (err429 as any).status = 429;
  t.true(isTransientRetryableError(err429));

  const err503 = new Error('service unavailable');
  (err503 as any).statusCode = 503;
  t.true(isTransientRetryableError(err503));
});

test('isTransientRetryableError: generic errors with rate-limit message are retryable', (t) => {
  t.true(
    isTransientRetryableError(new Error("We're currently processing too many requests — please try again later.")),
  );
  t.true(isTransientRetryableError(new Error('Rate limit exceeded')));
  t.true(isTransientRetryableError(new Error('rate_limit retry after 10s')));
});

test('isTransientRetryableError: non-retryable errors return false', (t) => {
  t.false(isTransientRetryableError(new Error('something else')));
  t.false(isTransientRetryableError(new ModelBehaviorError('Tool x not found')));
  t.false(isTransientRetryableError(null));
  t.false(isTransientRetryableError('string error'));
  t.false(isTransientRetryableError(42));
});
