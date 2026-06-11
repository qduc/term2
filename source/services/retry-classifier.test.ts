import test from 'ava';
import { ModelBehaviorError } from '@openai/agents';
import { APIConnectionTimeoutError } from 'openai';
import { OpenAICompatibleError } from '../providers/common/provider-errors.js';
import type { ClassificationContext } from './retry-contracts.js';
import { DefaultRetryClassifier } from './retry-classifier.js';

const makeClassifier = (agentClient: Record<string, any> = {}, random: () => number = Math.random) =>
  new DefaultRetryClassifier(agentClient as any, random);

const baseCounts = (): ClassificationContext['retryCounts'] => ({
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
});

const baseContext = (overrides: Partial<ClassificationContext> = {}): ClassificationContext => ({
  error: new Error('boom'),
  retryCounts: baseCounts(),
  stream: null,
  maxTransientRetries: 5,
  ...overrides,
});

function asInstanceOf<T extends object>(prototype: object, props: Partial<T>): T {
  return Object.assign(Object.create(prototype), props) as T;
}

test.skip('classify returns service_tier_fallback when agent client signals flex timeout', (t) => {
  const classifier = makeClassifier({ shouldRetryWithoutFlexServiceTier: () => true });

  const result = classifier.classify(baseContext());

  t.deepEqual(result, { kind: 'service_tier_fallback' });
});

test('classify does not return service_tier_fallback when already attempted', (t) => {
  const classifier = makeClassifier({ shouldRetryWithoutFlexServiceTier: () => true });

  const result = classifier.classify(
    baseContext({
      retryCounts: { ...baseCounts(), serviceTierFallbackCount: 1 },
    }),
  );

  t.not(result.kind, 'service_tier_fallback');
});

test.skip('classify returns transient for retryable upstream error with remaining attempts', (t) => {
  const classifier = makeClassifier({}, () => 0);

  const result = classifier.classify(
    baseContext({
      error: asInstanceOf<APIConnectionTimeoutError>(APIConnectionTimeoutError.prototype, { message: 'timeout' }),
      retryCounts: { ...baseCounts(), transientRetryCount: 1 },
    }),
  );

  t.is(result.kind, 'transient');
  if (result.kind !== 'transient') return;
  t.is(result.attempt, 2);
  t.is(result.delayMs, 900);
});

test.skip('classify respects Retry-After header from upstream error', (t) => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new OpenAICompatibleError('rate limited', 429, { 'Retry-After': '7' }),
    }),
  );

  t.is(result.kind, 'transient');
  if (result.kind !== 'transient') return;
  t.is(result.attempt, 1);
  t.is(result.delayMs, 7000);
});

test('classify does not call forceTransportDowngrade for non-retryable errors', (t) => {
  let downgradeCalled = false;
  const classifier = makeClassifier({
    forceTransportDowngrade: () => {
      downgradeCalled = true;
      return true;
    },
  });

  const result = classifier.classify(baseContext({ error: new Error('boom') }));

  t.is(result.kind, 'unrecoverable');
  t.false(downgradeCalled);
});

test('classify returns model_retry for recoverable model error with error context', (t) => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      stream: { completed: Promise.resolve(undefined) } as any,
      retryCounts: baseCounts(),
    }),
  );

  t.is(result.kind, 'model_retry');
  if (result.kind !== 'model_retry') return;
  t.truthy(result.errorContext);
  t.true(result.errorContext!.includes('fake_tool'));
});

test('classify returns model_retry without error context when stream produced no history', (t) => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      stream: null,
    }),
  );

  t.is(result.kind, 'model_retry');
  if (result.kind !== 'model_retry') return;
  t.is(result.errorContext, undefined);
});

test('classify returns unrecoverable when all retry limits are exhausted', (t) => {
  const classifier = makeClassifier({
    shouldRetryWithoutFlexServiceTier: () => true,
    forceTransportDowngrade: () => true,
  });

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      retryCounts: {
        transientRetryCount: 5,
        serviceTierFallbackCount: 1,
        modelRetryCount: 2,
        transportDowngradeCount: 1,
      },
    }),
  );

  t.deepEqual(result, { kind: 'unrecoverable' });
});

test('classify returns unrecoverable for generic non-retryable error', (t) => {
  const classifier = makeClassifier();

  const result = classifier.classify(baseContext({ error: new Error('unknown') }));

  t.deepEqual(result, { kind: 'unrecoverable' });
});

test('classify returns unrecoverable for 400 status error', (t) => {
  const classifier = makeClassifier();

  const result = classifier.classify(baseContext({ error: new OpenAICompatibleError('bad request', 400, {}) }));

  t.deepEqual(result, { kind: 'unrecoverable' });
});

test('classify returns unrecoverable when model retry count exceeds max', (t) => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      retryCounts: { ...baseCounts(), modelRetryCount: 2 },
      maxModelRetries: 2,
    }),
  );

  t.is(result.kind, 'unrecoverable');
});

test.skip('classify produces deterministic delay with fixed random', (t) => {
  const classifier = makeClassifier({}, () => 0);

  const result = classifier.classify(
    baseContext({
      error: asInstanceOf<APIConnectionTimeoutError>(APIConnectionTimeoutError.prototype, { message: 'timeout' }),
      retryCounts: { ...baseCounts(), transientRetryCount: 0 },
    }),
  );

  t.is(result.kind, 'transient');
  if (result.kind !== 'transient') return;
  t.is(result.delayMs, 450);
});
