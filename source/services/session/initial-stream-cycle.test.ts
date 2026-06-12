import test from 'ava';
import { InitialStreamCycle } from './initial-stream-cycle.js';
import { TurnAttempt } from './turn-attempt.js';
import { MockStream } from '../test-helpers/mock-stream.js';

function createAttempt() {
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token: 3,
    initialRetryCounts: {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
    initialLedgerSnapshot: [],
    maxTransientRetries: 2,
  });
  attempt.attachInput({
    streamInput: 'hello',
    inputSurgeKind: 'delta',
    effectiveTurn: attempt.turn,
  });
  return attempt;
}

test('starts and processes a stream, then returns the built response', async (t) => {
  const stream = new MockStream([]);
  stream.finalOutput = 'done';
  const recorded: unknown[] = [];
  const cycle = new InitialStreamCycle({
    agentClient: {
      startStream: async () => stream,
    } as any,
    approvalFlow: { clearPending: () => {} } as any,
    conversationStore: { getHistory: () => [] } as any,
    inputPlanner: {
      recordSuccess: (...args: unknown[]) => recorded.push(args),
    } as any,
    logger: { debug: () => {}, getCorrelationId: () => undefined } as any,
    providerContinuity: { previousResponseId: 'response-1' } as any,
    sessionId: 'session-1',
    shellAutoApproval: { clearCache: () => {} } as any,
    streamProcessor: {
      async *process() {
        yield { type: 'text_delta', delta: 'done' };
        return {
          finalOutput: 'done',
          reasoningOutput: '',
          emittedCommandIds: new Set<string>(),
          latestUsage: undefined,
        };
      },
      finalize: () => ({ kind: 'finalized' }),
    } as any,
    toolTracker: { argumentsById: new Map() } as any,
    turnAccumulator: { getTurnItems: () => [] } as any,
  });

  const events: unknown[] = [];
  const iterator = cycle.execute(createAttempt(), {});
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  t.deepEqual(events, [{ type: 'text_delta', delta: 'done' }]);
  t.is(next.value.kind, 'completed');
  if (next.value.kind !== 'completed') return;
  t.is(next.value.outcome.kind, 'response');
  if (next.value.outcome.kind === 'response') {
    t.is(next.value.outcome.result.finalText, 'done');
  }
  t.is(recorded.length, 1);
});

test('returns stale without building a result when finalization is stale', async (t) => {
  const stream = new MockStream([]);
  const cycle = new InitialStreamCycle({
    agentClient: { startStream: async () => stream } as any,
    approvalFlow: {} as any,
    conversationStore: { getHistory: () => [] } as any,
    inputPlanner: { recordSuccess: () => t.fail() } as any,
    logger: {} as any,
    providerContinuity: { previousResponseId: null } as any,
    sessionId: 'session-1',
    shellAutoApproval: {} as any,
    streamProcessor: {
      async *process() {
        return {
          finalOutput: '',
          reasoningOutput: '',
          emittedCommandIds: new Set<string>(),
          latestUsage: undefined,
        };
      },
      finalize: () => ({ kind: 'stale' }),
    } as any,
    toolTracker: { argumentsById: new Map() } as any,
    turnAccumulator: { getTurnItems: () => [] } as any,
  });

  const iterator = cycle.execute(createAttempt(), {});
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();

  t.deepEqual(next.value, { kind: 'stale' });
});
