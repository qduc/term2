import { it, expect } from 'vitest';
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

it('service_tier_fallback produces retry_fresh with delta input and useStandardServiceTier', () => {
  const result = policy.plan(baseRecoveryContext({ failure: { kind: 'service_tier_fallback' } }));
  expect(result).toEqual({ kind: 'retry_fresh', inputMode: 'delta', useStandardServiceTier: true });
});

it('transient failure with resumable stream replays full history', () => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'transient', attempt: 1, delayMs: 500 },
      stream: { state: {}, lastResponseId: 'resp-123' } as any,
    }),
  );

  expect(result).toEqual({ kind: 'retry_fresh', inputMode: 'full_history' });
});

it('transient failure without stream produces retry_fresh with full_history', () => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'transient', attempt: 2, delayMs: 1000 },
      stream: null,
    }),
  );

  expect(result).toEqual({ kind: 'retry_fresh', inputMode: 'full_history' });
});

it('transport_downgrade produces retry_fresh with full_history', () => {
  const result = policy.plan(baseRecoveryContext({ failure: { kind: 'transport_downgrade' } }));
  expect(result).toEqual({ kind: 'retry_fresh', inputMode: 'full_history' });
});

it('model_retry with stream produces replay_turn without rollback and with errorContext', () => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'model_retry', errorContext: 'Previous attempt failed' },
      stream: { state: {} } as any,
    }),
  );

  expect(result).toEqual({
    kind: 'replay_turn',
    inputMode: 'full_history',
    rollbackUserMessage: false,
    errorContext: 'Previous attempt failed',
  });
});

it('model_retry without stream produces replay_turn with rollback', () => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'model_retry' },
      stream: null,
    }),
  );

  expect(result).toEqual({ kind: 'replay_turn', inputMode: 'full_history', rollbackUserMessage: true });
});

it('unrecoverable produces terminate with empty events', () => {
  const result = policy.plan(baseRecoveryContext({ failure: { kind: 'unrecoverable' } }));

  expect(result).toEqual({ kind: 'terminate', events: [] });
});

it('fresh-start retries disabled converts non-unrecoverable failure without stream to terminate', () => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'transient', attempt: 1, delayMs: 500 },
      stream: null,
      freshStartRetriesAllowed: false,
    }),
  );

  expect(result).toEqual({ kind: 'terminate', events: [] });
});

it('fresh-start retries disabled terminates transport recovery even when stream exists', () => {
  const result = policy.plan(
    baseRecoveryContext({
      failure: { kind: 'transient', attempt: 1, delayMs: 500 },
      stream: { state: { _x: 1 } as any, lastResponseId: undefined } as any,
      freshStartRetriesAllowed: false,
    }),
  );

  expect(result).toEqual({ kind: 'terminate', events: [] });
});

// ── nextRetryCounts ────────────────────────────────────────────

it('nextRetryCounts increments transient count for transient failure', () => {
  const result = policy.nextRetryCounts(baseCounts(), { kind: 'transient', attempt: 3, delayMs: 500 });
  expect(result.transientRetryCount).toBe(3);
  expect(result.serviceTierFallbackCount).toBe(0);
});

it('nextRetryCounts increments service tier fallback count', () => {
  const result = policy.nextRetryCounts(baseCounts(), { kind: 'service_tier_fallback' });
  expect(result.serviceTierFallbackCount).toBe(1);
});

it('nextRetryCounts resets transient and increments transport downgrade', () => {
  const result = policy.nextRetryCounts({ ...baseCounts(), transientRetryCount: 5 }, { kind: 'transport_downgrade' });
  expect(result.transientRetryCount).toBe(0);
  expect(result.transportDowngradeCount).toBe(1);
});

it('nextRetryCounts increments model retry count', () => {
  const result = policy.nextRetryCounts(baseCounts(), { kind: 'model_retry', errorContext: 'x' });
  expect(result.modelRetryCount).toBe(1);
});

it('nextRetryCounts returns unchanged counts for unrecoverable', () => {
  const counts = baseCounts();
  const result = policy.nextRetryCounts(counts, { kind: 'unrecoverable' });
  expect(result).toEqual(counts);
});
