import { it, expect } from 'vitest';
import { ContinuationRecoveryHandler } from './continuation-recovery-handler.js';

function createMockState(overrides: any = {}) {
  return {
    token: 1,
    retryCounts: {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
    lastStream: null,
    journalSnapshot: [],
    currentState: { id: 'run-1' },
    currentCallIds: ['call-1'],
    setRetryCounts: (_counts: any) => {
      // mutate in place
    },
    setResumePreviousResponseId: (_id: any) => {},
    ...overrides,
  };
}

it('returns terminated for unrecoverable error', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'unrecoverable' }),
    } as any,
    recoveryPolicy: {} as any,
    recoveryExecutor: {} as any,
    retryEventPresenter: {} as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const events: any[] = [];
  const state = createMockState();
  const iterator = handler.handle({ error: new Error('boom'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.length).toBe(0);
  expect((next.value as any).kind).toBe('terminated');
});

it('returns stale when generation guard is not current after presentation', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => false } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transient', delayMs: 100 }),
    } as any,
    recoveryPolicy: {} as any,
    recoveryExecutor: {} as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const events: any[] = [];
  const state = createMockState();
  const iterator = handler.handle({ error: new Error('rate limit'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.length).toBe(1);
  expect((next.value as any).kind).toBe('stale');
});

it('returns fresh_start when recovery executor signals fresh start', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transient', delayMs: 500 }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => ({ ...counts, transientRetryCount: counts.transientRetryCount + 1 }),
      plan: () => ({ kind: 'transient' } as any),
    } as any,
    recoveryExecutor: {
      apply: () => ({ kind: 'fresh_start', instruction: {} as any }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const events: any[] = [];
  const state = createMockState();
  const iterator = handler.handle({ error: new Error('rate limit'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.length).toBe(1);
  const value = next.value as any;
  expect(value.kind).toBe('fresh_start');
  expect(value.delayMs).toBe(500);
});

it('returns fresh_start for a stale chained response transport downgrade', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transport_downgrade' }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => ({
        ...counts,
        transientRetryCount: 0,
        transportDowngradeCount: counts.transportDowngradeCount + 1,
      }),
      plan: () => ({ kind: 'retry_fresh', inputMode: 'full_history' }),
    } as any,
    recoveryExecutor: {
      apply: () => ({ kind: 'run', instruction: { skipUserMessage: true } }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const events: any[] = [];
  const state = createMockState();
  state.setRetryCounts = (counts: any) => {
    state.retryCounts = counts;
  };
  const iterator = handler.handle({
    error: Object.assign(new Error('previous response not found'), { code: 'previous_response_not_found' }),
    state,
  });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events).toHaveLength(1);
  expect(next.value).toMatchObject({
    kind: 'fresh_start',
    retryCounts: {
      transientRetryCount: 0,
      transportDowngradeCount: 1,
    },
  });
});

it('returns resume without widening currentCallIds back to the whole turn ledger', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transient', delayMs: 0 }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => ({ ...counts, transientRetryCount: counts.transientRetryCount + 1 }),
      plan: () => ({ kind: 'transient' } as any),
    } as any,
    recoveryExecutor: {
      apply: () => ({
        kind: 'recovered',
        instruction: { resumeState: { id: 'run-2' }, resumePreviousResponseId: 'prev-1' },
      }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => ['call-old', 'call-1'] } as any,
  });

  const events: any[] = [];
  const state = createMockState({ currentCallIds: ['call-1'] });
  const iterator = handler.handle({ error: new Error('rate limit'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.length).toBe(1);
  const value = next.value as any;
  expect(value.kind).toBe('resume');
  expect(state.currentState.id).toBe('run-2');
  expect(state.currentCallIds).toEqual(['call-1']);
});
