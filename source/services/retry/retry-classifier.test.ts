import { it, expect } from 'vitest';
import { ModelBehaviorError } from '@openai/agents';
import { OpenAICompatibleError } from '../../providers/common/provider-errors.js';
import { MissingChainedToolOutputError } from '../../lib/chained-input-filter.js';
import type { ClassificationContext } from './retry-contracts.js';
import { AmbiguousModelOutcomeError } from './retry-errors.js';
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

it('classify terminates an ambiguous provider outcome instead of replaying the turn', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({ error: new AmbiguousModelOutcomeError('request accepted but response was not acknowledged') }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify does not return service_tier_fallback when already attempted', () => {
  const classifier = makeClassifier({ shouldRetryWithoutFlexServiceTier: () => true });

  const result = classifier.classify(
    baseContext({
      retryCounts: { ...baseCounts(), serviceTierFallbackCount: 1 },
    }),
  );

  expect(result.kind).not.toBe('service_tier_fallback');
});

it('classify does not call forceTransportDowngrade for non-retryable errors', () => {
  let downgradeCalled = false;
  const classifier = makeClassifier({
    forceTransportDowngrade: () => {
      downgradeCalled = true;
      return true;
    },
  });

  const result = classifier.classify(baseContext({ error: new Error('boom') }));

  expect(result.kind).toBe('unrecoverable');
  expect(downgradeCalled).toBe(false);
});

it('classify returns model_retry for recoverable model error with error context', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      stream: { completed: Promise.resolve(undefined) } as any,
      retryCounts: baseCounts(),
    }),
  );

  expect(result.kind).toBe('model_retry');
  if (result.kind !== 'model_retry') return;
  expect(result.errorContext).toBeTruthy();
  expect(result.errorContext!.includes('fake_tool')).toBe(true);
});

it('classify returns model_retry without error context when stream produced no history', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      stream: null,
    }),
  );

  expect(result.kind).toBe('model_retry');
  if (result.kind !== 'model_retry') return;
  expect(result.errorContext).toBe(undefined);
});

it('classify returns unrecoverable when all retry limits are exhausted', () => {
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

  expect(result).toEqual({ kind: 'unrecoverable' });
});

it('classify returns unrecoverable for generic non-retryable error', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(baseContext({ error: new Error('unknown') }));

  expect(result).toEqual({ kind: 'unrecoverable' });
});

it('classify returns unrecoverable for 400 status error', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(baseContext({ error: new OpenAICompatibleError('bad request', 400, {}) }));

  expect(result).toEqual({ kind: 'unrecoverable' });
});

it('classify returns transport_downgrade for previous_response_not_found websocket 400 payload', () => {
  const classifier = makeClassifier();
  const error = Object.assign(
    new Error(
      'Unexpected server response: 400 {"error":{"code":"previous_response_not_found","message":"Previous response not found"}}',
    ),
    { status: 400 },
  );

  expect(classifier.classify(baseContext({ error })).kind).toBe('transport_downgrade');
});

it('classify returns transport_downgrade when a chained continuation is missing required tool output', () => {
  const classifier = makeClassifier();
  const error = new MissingChainedToolOutputError(['call-required']);

  expect(classifier.classify(baseContext({ error })).kind).toBe('transport_downgrade');
});

it('classify leaves unrelated websocket 400 errors unrecoverable', () => {
  const classifier = makeClassifier();
  const error = Object.assign(new Error('Unexpected server response: 400 {"error":{"code":"invalid_request_error"}}'), {
    status: 400,
  });

  expect(classifier.classify(baseContext({ error }))).toEqual({ kind: 'unrecoverable' });
});

it('classify returns unrecoverable when model retry count exceeds max', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      retryCounts: { ...baseCounts(), modelRetryCount: 2 },
      maxModelRetries: 2,
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify returns transient for undici onSocketClose TypeError mid-stream', () => {
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

  expect(result.kind).toBe('transient');
  if (result.kind !== 'transient') return;
  expect(result.attempt).toBe(1);
  expect(result.delayMs > 0 && result.delayMs <= 30000).toBe(true);
});

it('classify returns transient for ECONNRESET socket error', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('transient');
});

it('classify returns unrecoverable when transient retries are exhausted', () => {
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

  expect(result.kind).toBe('unrecoverable');
});

it('classify returns unrecoverable for plain TypeError (non-undici) with empty message', () => {
  const classifier = makeClassifier();

  const plain = new TypeError();
  plain.stack = 'TypeError\n    at userCode (file.ts:1:1)';

  const result = classifier.classify(
    baseContext({
      error: plain,
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify transient attempt count increments with prior transient retries', () => {
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

  expect(result.kind).toBe('transient');
  if (result.kind !== 'transient') return;
  expect(result.attempt).toBe(3);
});

it('classify returns transient for re-wrapped undici onSocketClose (Error with message "TypeError")', () => {
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

  expect(result.kind).toBe('transient');
  if (result.kind !== 'transient') return;
  expect(result.attempt).toBe(1);
  expect(result.delayMs > 0 && result.delayMs <= 30000).toBe(true);
});

it('classify returns unrecoverable for plain Error with message "TypeError" but no undici stack', () => {
  const classifier = makeClassifier();

  const plain = new Error('TypeError');
  plain.stack = 'Error: TypeError\n    at userCode (file.ts:1:1)';

  const result = classifier.classify(
    baseContext({
      error: plain,
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});
