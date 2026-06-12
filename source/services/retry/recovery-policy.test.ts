import test from 'ava';
import type { RecoveryContext, RetryCounts } from './retry-contracts.js';
import { DefaultConversationRecoveryPolicy } from './recovery-policy.js';

const policy = new DefaultConversationRecoveryPolicy();

const baseCounts = (): RetryCounts => ({
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
});

const baseRecoveryContext = (overrides: Partial<RecoveryContext> = {}): RecoveryContext => ({
  failure: { kind: 'unrecoverable' },
  gen: 1,
  stream: null,
  retryCounts: baseCounts(),
  freshStartRetriesAllowed: true,
  ...overrides,
});

test('service_tier_fallback produces retry_fresh with delta input and useStandardServiceTier', (t) => {
  const result = policy.plan(baseRecoveryContext({ failure: { kind: 'service_tier_fallback' } }));
  t.deepEqual(result, { kind: 'retry_fresh', inputMode: 'delta', useStandardServiceTier: true });
});

test('transient failure with resumable stream replays full history', (t) => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'transient', attempt: 1, delayMs: 500 },
      stream: { state: {}, lastResponseId: 'resp-123' } as any,
    }),
  );

  t.deepEqual(result, { kind: 'retry_fresh', inputMode: 'full_history' });
});

test('transient failure without stream produces retry_fresh with full_history', (t) => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'transient', attempt: 2, delayMs: 1000 },
      stream: null,
    }),
  );

  t.deepEqual(result, { kind: 'retry_fresh', inputMode: 'full_history' });
});

test('transport_downgrade produces retry_fresh with full_history', (t) => {
  const result = policy.plan(baseRecoveryContext({ failure: { kind: 'transport_downgrade' } }));
  t.deepEqual(result, { kind: 'retry_fresh', inputMode: 'full_history' });
});

test('model_retry with stream produces replay_turn without rollback and with errorContext', (t) => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'model_retry', errorContext: 'Previous attempt failed' },
      stream: { state: {} } as any,
    }),
  );

  t.deepEqual(result, {
    kind: 'replay_turn',
    inputMode: 'full_history',
    rollbackUserMessage: false,
    errorContext: 'Previous attempt failed',
  });
});

test('model_retry without stream produces replay_turn with rollback', (t) => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'model_retry' },
      stream: null,
    }),
  );

  t.deepEqual(result, { kind: 'replay_turn', inputMode: 'full_history', rollbackUserMessage: true });
});

test('unrecoverable produces terminate with empty events', (t) => {
  const result = policy.plan(baseRecoveryContext({ failure: { kind: 'unrecoverable' } }));

  t.deepEqual(result, { kind: 'terminate', events: [] });
});

test('fresh-start retries disabled converts non-unrecoverable failure without stream to terminate', (t) => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'transient', attempt: 1, delayMs: 500 },
      stream: null,
      freshStartRetriesAllowed: false,
    }),
  );

  t.deepEqual(result, { kind: 'terminate', events: [] });
});

test('fresh-start retries disabled terminates transport recovery even when stream exists', (t) => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'transient', attempt: 1, delayMs: 500 },
      stream: { state: { _x: 1 } as any, lastResponseId: undefined } as any,
      freshStartRetriesAllowed: false,
    }),
  );

  t.deepEqual(result, { kind: 'terminate', events: [] });
});

// ── nextRetryCounts ────────────────────────────────────────────

test('nextRetryCounts increments transient count for transient failure', (t) => {
  const result = policy.nextRetryCounts(baseCounts(), { kind: 'transient', attempt: 3, delayMs: 500 });
  t.is(result.transientRetryCount, 3);
  t.is(result.serviceTierFallbackCount, 0);
});

test('nextRetryCounts increments service tier fallback count', (t) => {
  const result = policy.nextRetryCounts(baseCounts(), { kind: 'service_tier_fallback' });
  t.is(result.serviceTierFallbackCount, 1);
});

test('nextRetryCounts resets transient and increments transport downgrade', (t) => {
  const result = policy.nextRetryCounts({ ...baseCounts(), transientRetryCount: 5 }, { kind: 'transport_downgrade' });
  t.is(result.transientRetryCount, 0);
  t.is(result.transportDowngradeCount, 1);
});

test('nextRetryCounts increments model retry count', (t) => {
  const result = policy.nextRetryCounts(baseCounts(), { kind: 'model_retry', errorContext: 'x' });
  t.is(result.modelRetryCount, 1);
});

test('nextRetryCounts returns unchanged counts for unrecoverable', (t) => {
  const counts = baseCounts();
  const result = policy.nextRetryCounts(counts, { kind: 'unrecoverable' });
  t.deepEqual(result, counts);
});
