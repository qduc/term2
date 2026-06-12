import test from 'ava';
import { ModelBehaviorError } from '@openai/agents';
import { OpenAICompatibleError } from '../../providers/common/provider-errors.js';
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

test('classify does not return service_tier_fallback when already attempted', (t) => {
  const classifier = makeClassifier({ shouldRetryWithoutFlexServiceTier: () => true });

  const result = classifier.classify(
    baseContext({
      retryCounts: { ...baseCounts(), serviceTierFallbackCount: 1 },
    }),
  );

  t.not(result.kind, 'service_tier_fallback');
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

test('classify returns transient for previous_response_not_found websocket 400 payload', (t) => {
  const classifier = makeClassifier();
  const error = Object.assign(
    new Error(
      'Unexpected server response: 400 {"error":{"code":"previous_response_not_found","message":"Previous response not found"}}',
    ),
    { status: 400 },
  );

  t.is(classifier.classify(baseContext({ error })).kind, 'transient');
});

test('classify leaves unrelated websocket 400 errors unrecoverable', (t) => {
  const classifier = makeClassifier();
  const error = Object.assign(new Error('Unexpected server response: 400 {"error":{"code":"invalid_request_error"}}'), {
    status: 400,
  });

  t.deepEqual(classifier.classify(baseContext({ error })), { kind: 'unrecoverable' });
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

test('classify returns transient for undici onSocketClose TypeError mid-stream', (t) => {
  const classifier = makeClassifier();

  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');

  const result = classifier.classify(
    baseContext({
      error: undiciSocketClose,
      retryCounts: baseCounts(),
      maxTransientRetries: 5,
    }),
  );

  t.is(result.kind, 'transient');
  if (result.kind !== 'transient') return;
  t.is(result.attempt, 1);
  t.true(result.delayMs > 0 && result.delayMs <= 30000);
});

test('classify returns transient for ECONNRESET socket error', (t) => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      maxTransientRetries: 5,
    }),
  );

  t.is(result.kind, 'transient');
});

test('classify returns unrecoverable when transient retries are exhausted', (t) => {
  const classifier = makeClassifier();

  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
  ].join('\n');

  const result = classifier.classify(
    baseContext({
      error: undiciSocketClose,
      retryCounts: { ...baseCounts(), transientRetryCount: 5 },
      maxTransientRetries: 5,
    }),
  );

  t.is(result.kind, 'unrecoverable');
});

test('classify returns unrecoverable for plain TypeError (non-undici) with empty message', (t) => {
  const classifier = makeClassifier();

  const plain = new TypeError();
  plain.stack = 'TypeError\n    at userCode (file.ts:1:1)';

  const result = classifier.classify(
    baseContext({
      error: plain,
      maxTransientRetries: 5,
    }),
  );

  t.is(result.kind, 'unrecoverable');
});

test('classify transient attempt count increments with prior transient retries', (t) => {
  const classifier = makeClassifier();

  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = ['TypeError', '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)'].join(
    '\n',
  );

  const result = classifier.classify(
    baseContext({
      error: undiciSocketClose,
      retryCounts: { ...baseCounts(), transientRetryCount: 2 },
      maxTransientRetries: 5,
    }),
  );

  t.is(result.kind, 'transient');
  if (result.kind !== 'transient') return;
  t.is(result.attempt, 3);
});

test('classify returns transient for re-wrapped undici onSocketClose (Error with message "TypeError")', (t) => {
  const classifier = makeClassifier();

  const rewrapped = new Error('TypeError');
  rewrapped.stack = [
    'Error: TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');

  const result = classifier.classify(
    baseContext({
      error: rewrapped,
      retryCounts: baseCounts(),
      maxTransientRetries: 5,
    }),
  );

  t.is(result.kind, 'transient');
  if (result.kind !== 'transient') return;
  t.is(result.attempt, 1);
  t.true(result.delayMs > 0 && result.delayMs <= 30000);
});

test('classify returns unrecoverable for plain Error with message "TypeError" but no undici stack', (t) => {
  const classifier = makeClassifier();

  const plain = new Error('TypeError');
  plain.stack = 'Error: TypeError\n    at userCode (file.ts:1:1)';

  const result = classifier.classify(
    baseContext({
      error: plain,
      maxTransientRetries: 5,
    }),
  );

  t.is(result.kind, 'unrecoverable');
});
