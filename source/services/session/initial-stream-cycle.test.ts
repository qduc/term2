import { it, expect } from 'vitest';
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

it('starts and processes a stream, then returns the built response', async () => {
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

  expect(events).toEqual([{ type: 'text_delta', delta: 'done' }]);
  expect(next.value.kind).toBe('completed');
  if (next.value.kind !== 'completed') return;
  expect(next.value.outcome.kind).toBe('response');
  if (next.value.outcome.kind === 'response') {
    expect(next.value.outcome.result.finalText).toBe('done');
  }
  expect(recorded.length).toBe(1);
});

it('returns stale without building a result when finalization is stale', async () => {
  const stream = new MockStream([]);
  const cycle = new InitialStreamCycle({
    agentClient: { startStream: async () => stream } as any,
    approvalFlow: {} as any,
    conversationStore: { getHistory: () => [] } as any,
    inputPlanner: { recordSuccess: () => expect(true).toBe(false) } as any,
    logger: {} as any,
    providerContinuity: { previousResponseId: null } as any,
    sessionId: 'session-1',
    shellAutoApproval: {} as any,
    streamProcessor: {
      async *process() {
        yield* [];
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

  expect(next.value).toEqual({ kind: 'stale' });
});
