import test from 'ava';
import { InitialTurnRecoveryHandler } from './initial-turn-recovery-handler.js';
import { TurnAttempt } from './turn-attempt.js';

function createAttempt() {
  return new TurnAttempt({
    turn: { text: 'retry me' },
    token: 2,
    initialRetryCounts: {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });
}

test('presents and applies a recoverable retry decision', async (t) => {
  const nextCounts = {
    transientRetryCount: 1,
    serviceTierFallbackCount: 0,
    modelRetryCount: 0,
    transportDowngradeCount: 0,
  };
  const handler = new InitialTurnRecoveryHandler({
    conversationStore: { getHistory: () => [] } as any,
    freshStartRetriesAllowed: true,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: { recordSuccess: () => {} } as any,
    logger: {
      warn: () => {},
      error: () => {},
      getCorrelationId: () => undefined,
    } as any,
    recoveryExecutor: {
      apply: () => ({
        kind: 'run',
        instruction: { skipUserMessage: true, retryCounts: nextCounts },
        events: [],
      }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: () => nextCounts,
      plan: () => ({ kind: 'retry_fresh', inputMode: 'full_history' }),
    } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transient', attempt: 1, delayMs: 25 }),
    } as any,
    retryEventPresenter: {
      present: () => ({
        event: { type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 25 },
        logMessage: 'Retrying',
        logFields: {},
      }),
    } as any,
    sessionId: 'session-1',
  });
  const attempt = createAttempt();

  const events: unknown[] = [];
  const iterator = handler.handle({ error: new Error('temporary'), attempt, stream: null });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  t.deepEqual(events, [{ type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 25 }]);
  t.is(next.value.kind, 'run');
  if (next.value.kind === 'run') {
    t.is(next.value.delayMs, 25);
  }
  t.deepEqual(attempt.retryCounts, nextCounts);
});

test('returns stale before classifying when the generation is outdated', async (t) => {
  const handler = new InitialTurnRecoveryHandler({
    conversationStore: {} as any,
    freshStartRetriesAllowed: true,
    generationGuard: { isCurrent: () => false } as any,
    inputPlanner: {} as any,
    logger: {} as any,
    recoveryExecutor: {} as any,
    recoveryPolicy: {} as any,
    retryClassifier: { classify: () => t.fail() } as any,
    retryEventPresenter: {} as any,
    sessionId: 'session-1',
  });

  const iterator = handler.handle({ error: new Error('stale'), attempt: createAttempt(), stream: null });
  const result = await iterator.next();

  t.true(result.done);
  t.deepEqual(result.value, { kind: 'stale' });
});
