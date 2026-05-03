import test from 'ava';
import { ModelBehaviorError } from '@openai/agents';
import { decideRetry, isRecoverableModelError, MAX_HALLUCINATION_RETRIES } from './conversation-retry-policy.js';

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

test('decideRetry: without stream returns retry with skipUserMessage=false', (t) => {
  const decision = decideRetry(new ModelBehaviorError('Tool x not found'), 0, false, 0);
  t.is(decision.kind, 'retry');
  if (decision.kind !== 'retry') return;
  t.false(decision.hadStream);
  t.false(decision.shouldInjectErrorContext);
  t.deepEqual(decision.nextRunOptions, { hallucinationRetryCount: 1, skipUserMessage: false });
});
