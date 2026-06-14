import test from 'ava';
import { RetryEventPresenter } from './retry-event-presenter.js';
import type { ClassifiedFailure } from './retry-contracts.js';

test('RetryEventPresenter handles transient retry (initial source)', (t) => {
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

  t.deepEqual(presentation.event, {
    type: 'retry',
    toolName: 'turn',
    attempt: 2,
    maxRetries: 5,
    errorMessage: 'Upstream down',
    retryType: 'upstream',
  });

  t.is(presentation.logMessage, 'Transient upstream error detected, retrying turn');
  t.deepEqual(presentation.logFields, {
    eventType: 'retry.transient',
    retryType: 'upstream',
    retryAttempt: 2,
    maxRetries: 5,
    errorMessage: 'Upstream down',
    delayMs: 1000,
  });
});

test('RetryEventPresenter handles transient retry (continuation source)', (t) => {
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

  t.deepEqual(presentation.event, {
    type: 'retry',
    toolName: 'continuation',
    attempt: 3,
    maxRetries: 5,
    errorMessage: 'String error message',
    retryType: 'upstream',
  });

  t.is(presentation.logMessage, 'Transient error in continuation, retrying');
  t.deepEqual(presentation.logFields, {
    eventType: 'retry.transient',
    retryType: 'upstream',
    retryAttempt: 3,
    maxRetries: 5,
    errorMessage: 'String error message',
    delayMs: 2000,
  });
});

test('RetryEventPresenter handles service-tier fallback', (t) => {
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

  t.deepEqual(presentation.event, {
    type: 'retry',
    toolName: 'service_tier',
    attempt: 1,
    maxRetries: 1,
    errorMessage: 'Flex service tier timed out. Falling back to standard service tier and retrying.',
    retryType: 'flex_service_tier',
  });

  t.is(presentation.logMessage, 'Flex service tier timed out, retrying with standard service tier');
  t.deepEqual(presentation.logFields, {
    eventType: 'retry.flex_service_tier',
    retryType: 'flex_service_tier',
    retryAttempt: 1,
    maxRetries: 1,
    errorMessage: 'Flex timeout',
  });
});

test('RetryEventPresenter handles transport downgrade', (t) => {
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

  t.deepEqual(presentation.event, {
    type: 'retry',
    toolName: 'transport',
    attempt: 1,
    maxRetries: 1,
    errorMessage: 'WebSocket retries exhausted. Falling back to HTTP transport and retrying.',
    retryType: 'upstream',
  });

  t.is(presentation.logMessage, 'Transient upstream error exhausted WS retries, forcing HTTP fallback');
  t.deepEqual(presentation.logFields, {
    eventType: 'retry.transport_fallback',
    retryType: 'upstream',
    retryAttempt: 1,
    maxRetries: 1,
    errorMessage: 'WS connection closed',
  });
});

test('RetryEventPresenter handles model retry', (t) => {
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

  t.deepEqual(presentation.event, {
    type: 'retry',
    toolName: 'model',
    attempt: 1,
    maxRetries: 4,
    errorMessage: 'Model hallucinated tool call',
    retryType: 'behavior',
  });

  t.is(presentation.logMessage, 'Recoverable model error detected, retrying');
  t.deepEqual(presentation.logFields, {
    eventType: 'retry.model_error',
    retryType: 'hallucination',
    retryAttempt: 1,
    maxRetries: 4,
    errorMessage: 'Model hallucinated tool call',
  });
});

test('RetryEventPresenter handles model retry with specific event', (t) => {
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

  t.is(presentation.event, mockRetryEvent);
  t.is(presentation.logMessage, 'Recoverable model error detected, retrying');
});
