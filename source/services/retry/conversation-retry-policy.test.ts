import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ModelBehaviorError } from '@openai/agents';
import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenRouterError, OpenAICompatibleError } from '../../providers/common/provider-errors.js';
import {
  decideRecoverableModelRetry,
  decideRetry,
  isRecoverableModelError,
  isTransientRetryableError,
  MAX_HALLUCINATION_RETRIES,
} from './conversation-retry-policy.js';

it('isRecoverableModelError: non-ModelBehaviorError returns false', () => {
  expect(isRecoverableModelError(new Error('boom'))).toBe(false);
  expect(isRecoverableModelError('boom')).toBe(false);
  expect(isRecoverableModelError(null)).toBe(false);
});

it('isRecoverableModelError: hallucination message returns true', () => {
  expect(isRecoverableModelError(new ModelBehaviorError('Tool fake_tool not found'))).toBe(true);
});

it('isRecoverableModelError: parsing tool arguments returns true', () => {
  expect(isRecoverableModelError(new ModelBehaviorError('Error parsing tool arguments'))).toBe(true);
});

it('isRecoverableModelError: valid json returns true', () => {
  expect(isRecoverableModelError(new ModelBehaviorError('arguments must be valid json'))).toBe(true);
});

it('isRecoverableModelError: model did not produce a final response returns true', () => {
  expect(isRecoverableModelError(new ModelBehaviorError('Model did not produce a final response'))).toBe(true);
});

it('isRecoverableModelError: unrelated ModelBehaviorError returns false', () => {
  expect(isRecoverableModelError(new ModelBehaviorError('something else'))).toBe(false);
});

it('decideRetry: non-recoverable error returns no_retry', () => {
  const decision = decideRetry(new Error('boom'), 0, true, 0);
  expect(decision.kind).toBe('no_retry');
});

it('decideRetry: at MAX attempts returns no_retry', () => {
  const decision = decideRetry(new ModelBehaviorError('Tool x not found'), MAX_HALLUCINATION_RETRIES, true, 0);
  expect(decision.kind).toBe('no_retry');
});

it('decideRetry: hallucination at attempt 0 returns retry with tool name extracted', () => {
  const decision = decideRetry(new ModelBehaviorError('Tool fake_tool not found'), 0, true, 5);
  expect(decision.kind).toBe('retry');
  if (decision.kind !== 'retry') return;
  expect(decision.retryEvent.toolName).toBe('fake_tool');
  expect(decision.retryEvent.attempt).toBe(1);
  expect(decision.logPayload.retryType).toBe('hallucination');
  expect(decision.logPayload.toolName).toBe('fake_tool');
  expect(decision.hadStream).toBe(true);
  expect(decision.shouldInjectErrorContext).toBe(false);
  expect(decision.nextRunOptions).toEqual({ retries: { hallucinationRetryCount: 1 }, skipUserMessage: true });
});

it('decideRetry: parsing error returns retry with toolName=model and parsing_error type', () => {
  const decision = decideRetry(new ModelBehaviorError('Error parsing tool arguments'), 0, true, 0);
  expect(decision.kind).toBe('retry');
  if (decision.kind !== 'retry') return;
  expect(decision.retryEvent.toolName).toBe('model');
  expect(decision.logPayload.retryType).toBe('parsing_error');
  expect(decision.logPayload.toolName).toBe('unknown');
});

it('decideRetry: behavior (model did not produce) returns retry with behavior type', () => {
  const decision = decideRetry(new ModelBehaviorError('Model did not produce a final response'), 1, true, 3);
  expect(decision.kind).toBe('retry');
  if (decision.kind !== 'retry') return;
  expect(decision.logPayload.retryType).toBe('behavior');
  expect(decision.attempt).toBe(2);
});

it('decideRetry: with stream and empty history sets shouldInjectErrorContext', () => {
  const decision = decideRetry(new ModelBehaviorError('Tool x not found'), 0, true, 0);
  expect(decision.kind).toBe('retry');
  if (decision.kind !== 'retry') return;
  expect(decision.shouldInjectErrorContext).toBe(true);
  expect(decision.errorContextMessage.includes('Previous attempt failed')).toBe(true);
});

it('decideRetry: without stream returns retry with skipUserMessage=false', async () => {
  const decision = decideRetry(new ModelBehaviorError('Tool x not found'), 0, false, 0);
  expect(decision.kind).toBe('retry');
  if (decision.kind !== 'retry') return;
  expect(decision.hadStream).toBe(false);
  expect(decision.shouldInjectErrorContext).toBe(false);
  expect(decision.nextRunOptions).toEqual({ retries: { hallucinationRetryCount: 1 }, skipUserMessage: false });
});

// ========== decideRecoverableModelRetry (shared helper) ==========

it('decideRecoverableModelRetry: hallucinated tool extracts tool name', () => {
  const decision = decideRecoverableModelRetry(new ModelBehaviorError('Tool bash not found in agent Explorer.'), 0);
  expect(decision.kind).toBe('retry');
  if (decision.kind !== 'retry') return;
  expect(decision.toolName).toBe('bash');
  expect(decision.retryType).toBe('hallucination');
  expect(decision.attempt).toBe(1);
  expect(decision.maxRetries).toBe(MAX_HALLUCINATION_RETRIES);
  expect(decision.message.includes('bash')).toBeTruthy();
});

it('decideRecoverableModelRetry: parsing error classifies as parsing_error', () => {
  const decision = decideRecoverableModelRetry(new ModelBehaviorError('Error parsing tool arguments'), 0);
  expect(decision.kind).toBe('retry');
  if (decision.kind !== 'retry') return;
  expect(decision.retryType).toBe('parsing_error');
  expect(decision.toolName).toBe('unknown');
  expect(decision.attempt).toBe(1);
});

it('decideRecoverableModelRetry: behavior error classifies as behavior', () => {
  const decision = decideRecoverableModelRetry(new ModelBehaviorError('Model did not produce a final response'), 0);
  expect(decision.kind).toBe('retry');
  if (decision.kind !== 'retry') return;
  expect(decision.retryType).toBe('behavior');
  expect(decision.toolName).toBe('unknown');
  expect(decision.attempt).toBe(1);
});

it('decideRecoverableModelRetry: max attempts returns no_retry', () => {
  const decision = decideRecoverableModelRetry(
    new ModelBehaviorError('Tool bash not found'),
    MAX_HALLUCINATION_RETRIES,
  );
  expect(decision.kind).toBe('no_retry');
});

it('decideRecoverableModelRetry: non-recoverable error returns no_retry', () => {
  expect(decideRecoverableModelRetry(new Error('regular error'), 0).kind).toBe('no_retry');
  expect(decideRecoverableModelRetry(new ModelBehaviorError('unrelated error'), 0).kind).toBe('no_retry');
});

it('decideRecoverableModelRetry: respects custom maxRetries=1 and returns no_retry at attempt 1', () => {
  const stillRetry = decideRecoverableModelRetry(new ModelBehaviorError('Tool bash not found'), 0, 1);
  expect(stillRetry.kind).toBe('retry');
  if (stillRetry.kind !== 'retry') return;
  expect(stillRetry.maxRetries).toBe(1);

  const exhausted = decideRecoverableModelRetry(new ModelBehaviorError('Tool bash not found'), 1, 1);
  expect(exhausted.kind).toBe('no_retry');
});

function asInstanceOf<T extends object>(prototype: object, props: Partial<T>): T {
  return Object.assign(Object.create(prototype), props) as T;
}

it('isTransientRetryableError: OpenAI SDK errors are retryable', () => {
  expect(isTransientRetryableError(asInstanceOf(APIConnectionError.prototype, { message: 'conn error' }))).toBe(true);
  expect(isTransientRetryableError(asInstanceOf(APIConnectionTimeoutError.prototype, { message: 'timeout' }))).toBe(
    true,
  );
  expect(isTransientRetryableError(asInstanceOf(InternalServerError.prototype, { message: 'ise', status: 500 }))).toBe(
    true,
  );
  expect(
    isTransientRetryableError(asInstanceOf(RateLimitError.prototype, { message: 'rate limit', status: 429 })),
  ).toBe(true);
});

it('isTransientRetryableError: OpenRouter 429/5xx are retryable', () => {
  expect(isTransientRetryableError(new OpenRouterError('rate limited', 429, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenRouterError('server error', 500, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenRouterError('bad gateway', 502, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenRouterError('not found', 404, {}))).toBe(false);
});

it('isTransientRetryableError: OpenAI-compatible 429/5xx are retryable', () => {
  expect(isTransientRetryableError(new OpenAICompatibleError('rate limited', 429, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenAICompatibleError('server error', 503, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenAICompatibleError('bad request', 400, {}))).toBe(false);
});

it('isTransientRetryableError: generic errors with 429/5xx status are retryable', () => {
  const err429 = new Error('too many requests');
  (err429 as any).status = 429;
  expect(isTransientRetryableError(err429)).toBe(true);

  const err503 = new Error('service unavailable');
  (err503 as any).statusCode = 503;
  expect(isTransientRetryableError(err503)).toBe(true);
});

it('isTransientRetryableError: generic errors with rate-limit message are retryable', () => {
  expect(
    isTransientRetryableError(new Error("We're currently processing too many requests — please try again later.")),
  ).toBe(true);
  expect(isTransientRetryableError(new Error('Rate limit exceeded'))).toBe(true);
  expect(isTransientRetryableError(new Error('rate_limit retry after 10s'))).toBe(true);
});

it('isTransientRetryableError: websocket response completion closes are retryable unless policy close code is present', () => {
  expect(isTransientRetryableError(new Error('WebSocket connection closed before response completed'))).toBe(true);
  expect(
    isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1006)')),
  ).toBe(true);
  expect(
    isTransientRetryableError(
      new Error('WebSocket connection closed before response completed (code=1008, reason="rate limit exceeded")'),
    ),
  ).toBe(false);
});

it('isTransientRetryableError: terminated errors are retryable', () => {
  expect(isTransientRetryableError('terminated')).toBe(true);
  expect(isTransientRetryableError('terminated: other side closed')).toBe(true);
  expect(isTransientRetryableError(new Error('terminated'))).toBe(true);
  expect(isTransientRetryableError(new Error('terminated: other side closed'))).toBe(true);
});

it('isTransientRetryableError: non-retryable errors return false', () => {
  expect(isTransientRetryableError(new Error('something else'))).toBe(false);
  expect(isTransientRetryableError(new ModelBehaviorError('Tool x not found'))).toBe(false);
  expect(isTransientRetryableError(null)).toBe(false);
  expect(isTransientRetryableError('string error')).toBe(false);
  expect(isTransientRetryableError('unterminated string')).toBe(false);
  expect(isTransientRetryableError(new Error('unterminated string'))).toBe(false);
  expect(isTransientRetryableError(42)).toBe(false);
});
