import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { TurnAttemptFactory } from './turn-attempt-factory.js';

function setup(options: { pendingModeNotice?: string | null; lastUserMessage?: string } = {}) {
  let aborted = false;
  const factory = new TurnAttemptFactory({
    agentClient: {
      abort() {
        aborted = true;
      },
    } as any,
    conversationStore: {
      getLastUserMessage() {
        if (options.lastUserMessage === undefined) {
          throw new Error('No user message');
        }
        return options.lastUserMessage;
      },
    } as any,
    generationGuard: {
      capture: () => 7,
      isCurrent: (token: number) => token === 7,
    } as any,
    toolTracker: {
      export: () => [{ callId: 'call-1' }],
    } as any,
    state: {
      pendingModeNotice: options.pendingModeNotice ?? null,
    } as any,
    resolveRetryLimit: () => 3,
  });

  return { factory, wasAborted: () => aborted };
}

it('creates an attempt with normalized legacy retry counts and pending mode notice', () => {
  const { factory } = setup({ pendingModeNotice: 'Plan mode enabled' });

  const result = factory.create('Do the work', {
    retries: {
      transientRetryCount: 1,
      flexServiceTierFallbackCount: 2,
      hallucinationRetryCount: 3,
      transportFallbackRetryCount: 4,
    },
    maxModelRetries: 5,
  });

  expect(result.kind).toBe('created');
  if (result.kind !== 'created') return;
  expect(result.attempt.turn.text).toBe('Plan mode enabled\n\nDo the work');
  expect(result.attempt.retryCounts).toEqual({
    transientRetryCount: 1,
    serviceTierFallbackCount: 2,
    modelRetryCount: 3,
    transportDowngradeCount: 4,
  });
  expect(result.attempt.maxTransientRetries).toBe(3);
  expect(result.attempt.maxModelRetries).toBe(5);
  expect(result.attempt.initialLedgerSnapshot).toEqual([{ callId: 'call-1' }]);
});

it('recovers the last user message for a skipped empty turn', () => {
  const { factory } = setup({ lastUserMessage: 'Previous request' });

  const result = factory.create({ text: '' }, { skipUserMessage: true });

  expect(result.kind).toBe('created');
  if (result.kind !== 'created') return;
  expect(result.attempt.turn.text).toBe('Previous request');
});

it('returns stale for an outdated aborted approval context', () => {
  const { factory } = setup();

  const result = factory.create('Resume', {
    abortedContext: { token: 6 } as any,
  });

  expect(result).toEqual({ kind: 'stale' });
});

it('wires the attempt abort signal to the agent client', () => {
  const controller = new AbortController();
  const { factory, wasAborted } = setup();

  const result = factory.create('Run', { signal: controller.signal });
  expect(result.kind).toBe('created');

  controller.abort();
  expect(wasAborted()).toBe(true);
  if (result.kind === 'created') result.attempt.close();
});
