import { it, expect } from 'vitest';
import { InitialInputPreparer } from './initial-input-preparer.js';
import { TurnAttempt } from './turn-attempt.js';

function createAttempt() {
  return new TurnAttempt({
    turn: {
      text: 'hello',
      images: [{ id: 'image-1', mimeType: 'image/png', data: 'abc', byteSize: 3, displayNumber: 1 }],
    },
    token: 4,
    initialRetryCounts: {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
    initialJournalSnapshot: [],
    maxTransientRetries: 2,
  });
}

it('adds the user turn once and attaches the planned input', () => {
  const added: unknown[] = [];
  const attempt = createAttempt();
  const preparer = new InitialInputPreparer({
    conversationStore: {
      addUserTurn: (turn: unknown) => added.push(turn),
    } as any,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: {
      build: () => ({
        streamInput: ['history'],
        inputSurgeKind: 'full_history',
        effectiveTurn: attempt.turn,
      }),
      inspectForSurge: () => ({ action: 'allow' }),
    } as any,
    logger: { warn: () => {}, getCorrelationId: () => undefined } as any,
    sessionId: 'session-1',
    state: { pendingModeNotice: 'notice' } as any,
  });

  expect(preparer.prepare(attempt, false)).toEqual({ kind: 'ready' });
  expect(preparer.prepare(attempt, false)).toEqual({ kind: 'ready' });
  expect(added.length).toBe(1);
  expect(attempt.streamInput).toEqual(['history']);
  expect(attempt.inputMode).toBe('full_history');
});

it('rolls back an inserted user turn when the surge guard blocks', () => {
  let removed = 0;
  const attempt = createAttempt();
  const preparer = new InitialInputPreparer({
    conversationStore: {
      addUserTurn: () => {},
      removeLastUserMessage: () => {
        removed++;
      },
    } as any,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: {
      build: () => ({
        streamInput: 'input',
        inputSurgeKind: 'delta',
        effectiveTurn: attempt.turn,
      }),
      inspectForSurge: () => ({
        action: 'block',
        reason: 'Too large',
        stats: {},
        previousStats: {},
      }),
    } as any,
    logger: { warn: () => {}, getCorrelationId: () => 'trace-1' } as any,
    sessionId: 'session-1',
    state: { pendingModeNotice: null } as any,
  });

  const result = preparer.prepare(attempt, false);

  expect(result.kind).toBe('blocked');
  if (result.kind !== 'blocked') return;
  expect(removed).toBe(1);
  expect(result.event.droppedUserMessage).toEqual({ text: 'hello', imageCount: 1 });
});

it('does not roll back a user turn after the generation becomes stale', () => {
  let removed = 0;
  const attempt = createAttempt();
  const preparer = new InitialInputPreparer({
    conversationStore: {
      addUserTurn: () => {},
      removeLastUserMessage: () => {
        removed++;
      },
    } as any,
    generationGuard: { isCurrent: () => false } as any,
    inputPlanner: {
      build: () => ({
        streamInput: 'input',
        inputSurgeKind: 'delta',
        effectiveTurn: attempt.turn,
      }),
      inspectForSurge: () => ({
        action: 'block',
        reason: 'Too large',
        stats: {},
        previousStats: {},
      }),
    } as any,
    logger: { warn: () => {}, getCorrelationId: () => undefined } as any,
    sessionId: 'session-1',
    state: { pendingModeNotice: null } as any,
  });

  preparer.prepare(attempt, false);

  expect(removed).toBe(0);
});
