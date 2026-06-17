import { it, expect } from 'vitest';
import { RetryEventPresenter } from './retry-event-presenter.js';
import type { ClassifiedFailure } from './retry-contracts.js';

it('RetryEventPresenter handles transient retry (initial source)', () => {
  const presenter = new RetryEventPresenter();
  const failure: ClassifiedFailure = {
    kind: 'transient',
    attempt: 2,
    delayMs: 1000,
  };
  const error = new Error('Upstream down');

  const presentation = presenter.present({
    failure,
    maxTransientRetries: 5,
    source: 'initial',
    error,
  });

  expect(presentation.event).toEqual({
    type: 'retry',
    toolName: 'turn',
    attempt: 2,
    maxRetries: 5,
    errorMessage: 'Upstream down',
    retryType: 'upstream',
  });

  expect(presentation.logMessage).toBe('Transient upstream error detected, retrying turn');
  expect(presentation.logFields).toEqual({
    eventType: 'retry.transient',
    retryType: 'upstream',
    retryAttempt: 2,
    maxRetries: 5,
    errorMessage: 'Upstream down',
    delayMs: 1000,
  });
});

it('RetryEventPresenter handles transient retry (continuation source)', () => {
  const presenter = new RetryEventPresenter();
  const failure: ClassifiedFailure = {
    kind: 'transient',
    attempt: 3,
    delayMs: 2000,
  };
  const error = 'String error message';

  const presentation = presenter.present({
    failure,
    maxTransientRetries: 5,
    source: 'continuation',
    error,
  });

  expect(presentation.event).toEqual({
    type: 'retry',
    toolName: 'continuation',
    attempt: 3,
    maxRetries: 5,
    errorMessage: 'String error message',
    retryType: 'upstream',
  });

  expect(presentation.logMessage).toBe('Transient error in continuation, retrying');
  expect(presentation.logFields).toEqual({
    eventType: 'retry.transient',
    retryType: 'upstream',
    retryAttempt: 3,
    maxRetries: 5,
    errorMessage: 'String error message',
    delayMs: 2000,
  });
});

it('RetryEventPresenter handles service-tier fallback', () => {
  const presenter = new RetryEventPresenter();
  const failure: ClassifiedFailure = {
    kind: 'service_tier_fallback',
  };
  const error = new Error('Flex timeout');

  const presentation = presenter.present({
    failure,
    maxTransientRetries: 3,
    source: 'initial',
    error,
  });

  expect(presentation.event).toEqual({
    type: 'retry',
    toolName: 'service_tier',
    attempt: 1,
    maxRetries: 1,
    errorMessage: 'Flex service tier timed out. Falling back to standard service tier and retrying.',
    retryType: 'flex_service_tier',
  });

  expect(presentation.logMessage).toBe('Flex service tier timed out, retrying with standard service tier');
  expect(presentation.logFields).toEqual({
    eventType: 'retry.flex_service_tier',
    retryType: 'flex_service_tier',
    retryAttempt: 1,
    maxRetries: 1,
    errorMessage: 'Flex timeout',
  });
});

it('RetryEventPresenter handles transport downgrade', () => {
  const presenter = new RetryEventPresenter();
  const failure: ClassifiedFailure = {
    kind: 'transport_downgrade',
  };
  const error = new Error('WS connection closed');

  const presentation = presenter.present({
    failure,
    maxTransientRetries: 3,
    source: 'initial',
    error,
  });

  expect(presentation.event).toEqual({
    type: 'retry',
    toolName: 'transport',
    attempt: 1,
    maxRetries: 1,
    errorMessage: 'WebSocket retries exhausted. Falling back to HTTP transport and retrying.',
    retryType: 'upstream',
  });

  expect(presentation.logMessage).toBe('Transient upstream error exhausted WS retries, forcing HTTP fallback');
  expect(presentation.logFields).toEqual({
    eventType: 'retry.transport_fallback',
    retryType: 'upstream',
    retryAttempt: 1,
    maxRetries: 1,
    errorMessage: 'WS connection closed',
  });
});

it('RetryEventPresenter handles model retry', () => {
  const presenter = new RetryEventPresenter();
  const failure: ClassifiedFailure = {
    kind: 'model_retry',
  };
  const error = new Error('Model hallucinated tool call');

  const presentation = presenter.present({
    failure,
    maxTransientRetries: 3,
    maxModelRetries: 4,
    source: 'initial',
    error,
  });

  expect(presentation.event).toEqual({
    type: 'retry',
    toolName: 'model',
    attempt: 1,
    maxRetries: 4,
    errorMessage: 'Model hallucinated tool call',
    retryType: 'behavior',
  });

  expect(presentation.logMessage).toBe('Recoverable model error detected, retrying');
  expect(presentation.logFields).toEqual({
    eventType: 'retry.model_error',
    retryType: 'hallucination',
    retryAttempt: 1,
    maxRetries: 4,
    errorMessage: 'Model hallucinated tool call',
  });
});

it('RetryEventPresenter handles model retry with specific event', () => {
  const presenter = new RetryEventPresenter();
  const mockRetryEvent = {
    type: 'retry' as const,
    toolName: 'custom-model',
    attempt: 2,
    maxRetries: 3,
    errorMessage: 'Specific model failure',
    retryType: 'parsing_error' as const,
  };
  const failure: ClassifiedFailure = {
    kind: 'model_retry',
    retryEvent: mockRetryEvent,
  };
  const error = new Error('Parsing error');

  const presentation = presenter.present({
    failure,
    maxTransientRetries: 3,
    source: 'initial',
    error,
  });

  expect(presentation.event).toBe(mockRetryEvent);
  expect(presentation.logMessage).toBe('Recoverable model error detected, retrying');
});
