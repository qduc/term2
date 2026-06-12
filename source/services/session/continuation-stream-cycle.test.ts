import test from 'ava';
import { ContinuationStreamCycle } from './continuation-stream-cycle.js';
import { MockStream } from '../test-helpers/mock-stream.js';

function createMockStream() {
  return new MockStream([]);
}

function createMockState() {
  return {
    token: 1,
    currentState: { id: 'run-1' },
    currentCallIds: ['call-1'],
    source: 'continueRunStream' as const,
    previouslyEmittedIds: new Set<string>(),
    inputMode: 'delta' as const,
    cumulativeCommandMessages: [],
    cumulativeUsage: undefined,
    setLastStream: () => {},
  } as any;
}

test('returns stale when finalization is stale', async (t) => {
  const stream = createMockStream();
  const cycle = new ContinuationStreamCycle({
    agentClient: {
      continueRunStream: async () => stream,
    } as any,
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
    conversationStore: { getHistory: () => [] } as any,
    turnAccumulator: { getTurnItems: () => [] } as any,
    toolTracker: { argumentsById: new Map() } as any,
    approvalFlow: {} as any,
    shellAutoApproval: {} as any,
    logger: { debug: () => {}, getCorrelationId: () => undefined } as any,
    sessionId: 'session-1',
    providerContinuity: { previousResponseId: 'response-1' } as any,
  });

  const iterator = cycle.execute(createMockState());
  let next = await iterator.next();
  while (!next.done) {
    next = await iterator.next();
  }
  t.is((next.value as any).kind, 'stale');
});

test('returns completed response after stream processing', async (t) => {
  const stream = createMockStream();
  stream.finalOutput = 'done';

  const cycle = new ContinuationStreamCycle({
    agentClient: {
      continueRunStream: async (_state: unknown, _options: unknown) => stream,
    } as any,
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
    conversationStore: { getHistory: () => [] } as any,
    turnAccumulator: { getTurnItems: () => [] } as any,
    toolTracker: { argumentsById: new Map() } as any,
    approvalFlow: { clearPending: () => {} } as any,
    shellAutoApproval: { clearCache: () => {} } as any,
    logger: { debug: () => {}, getCorrelationId: () => undefined } as any,
    sessionId: 'session-1',
    providerContinuity: { previousResponseId: null } as any,
  });

  const events: unknown[] = [];
  const iterator = cycle.execute(createMockState());
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  t.deepEqual(events, [{ type: 'text_delta', delta: 'done' }]);
  t.is((next.value as any).kind, 'completed');
  if ((next.value as any).kind === 'completed') {
    t.is((next.value as any).outcome.kind, 'response');
  }
});

test('accumulates command messages from stream', async (t) => {
  const stream = createMockStream();
  stream.newItems = [
    { type: 'function_call_output', id: 'msg-1', name: 'shell', output: { command: 'ls', output: 'a' } },
  ];
  stream.finalOutput = 'done';

  const state = createMockState();
  state.cumulativeCommandMessages = [{ id: 'msg-0', command: 'pwd', output: '/' } as any];

  const cycle = new ContinuationStreamCycle({
    agentClient: {
      continueRunStream: async () => stream,
    } as any,
    streamProcessor: {
      async *process() {
        return {
          finalOutput: 'done',
          reasoningOutput: '',
          emittedCommandIds: new Set<string>(),
          latestUsage: undefined,
        };
      },
      finalize: () => ({ kind: 'finalized' }),
    } as any,
    conversationStore: { getHistory: () => [] } as any,
    turnAccumulator: { getTurnItems: () => [] } as any,
    toolTracker: { argumentsById: new Map() } as any,
    approvalFlow: { clearPending: () => {} } as any,
    shellAutoApproval: { clearCache: () => {} } as any,
    logger: { debug: () => {}, getCorrelationId: () => undefined } as any,
    sessionId: 'session-1',
    providerContinuity: { previousResponseId: null } as any,
  });

  const iterator = cycle.execute(state);
  let next = await iterator.next();
  while (!next.done) {
    next = await iterator.next();
  }
  const value = next.value as any;
  if (value.kind === 'completed') {
    const msgs = value.nextCumulativeMessages;
    t.is(msgs.length, 2);
    t.is(msgs[0].id, 'msg-0');
    t.is(msgs[1].toolName, 'shell');
  }
});
