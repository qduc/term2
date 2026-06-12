import test from 'ava';
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

test('creates an attempt with normalized legacy retry counts and pending mode notice', (t) => {
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

  t.is(result.kind, 'created');
  if (result.kind !== 'created') return;
  t.is(result.attempt.turn.text, 'Plan mode enabled\n\nDo the work');
  t.deepEqual(result.attempt.retryCounts, {
    transientRetryCount: 1,
    serviceTierFallbackCount: 2,
    modelRetryCount: 3,
    transportDowngradeCount: 4,
  });
  t.is(result.attempt.maxTransientRetries, 3);
  t.is(result.attempt.maxModelRetries, 5);
  t.deepEqual(result.attempt.initialLedgerSnapshot, [{ callId: 'call-1' }]);
});

test('recovers the last user message for a skipped empty turn', (t) => {
  const { factory } = setup({ lastUserMessage: 'Previous request' });

  const result = factory.create({ text: '' }, { skipUserMessage: true });

  t.is(result.kind, 'created');
  if (result.kind !== 'created') return;
  t.is(result.attempt.turn.text, 'Previous request');
});

test('returns stale for an outdated aborted approval context', (t) => {
  const { factory } = setup();

  const result = factory.create('Resume', {
    abortedContext: { token: 6 } as any,
  });

  t.deepEqual(result, { kind: 'stale' });
});

test('wires the attempt abort signal to the agent client', (t) => {
  const controller = new AbortController();
  const { factory, wasAborted } = setup();

  const result = factory.create('Run', { signal: controller.signal });
  t.is(result.kind, 'created');

  controller.abort();
  t.true(wasAborted());
  if (result.kind === 'created') result.attempt.close();
});
