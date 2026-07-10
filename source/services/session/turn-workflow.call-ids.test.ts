import { expect, it } from 'vitest';
import { createSessionRuntimeInternals } from './session-composition.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { MockStream } from '../test-helpers/mock-stream.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

const createSessionContextService = () => ({
  runWithContext: (_context: unknown, fn: () => unknown) => fn(),
});

const collect = async (iterable: AsyncGenerator<unknown, unknown, void>) => {
  let next = await iterable.next();
  while (!next.done) {
    next = await iterable.next();
  }
  return next.value;
};

type ContinuationRunState = {
  getInterruptions: () => unknown[];
  _generatedItems?: unknown[];
};

const runResponseContinuation = async ({
  runState,
  history = [],
  ledgerCallIds = [],
}: {
  runState: ContinuationRunState;
  history?: unknown[];
  ledgerCallIds?: string[];
}) => {
  let receivedCallIds: string[] | undefined;

  const mockClient = {
    getProvider: () => 'openai',
    async continueRunStream(_state: unknown, options: { toolResultCallIds?: string[] }) {
      receivedCallIds = options.toolResultCallIds;
      const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'done' }]);
      stream.finalOutput = 'done';
      return stream;
    },
  };

  const composition = createSessionRuntimeInternals({
    sessionId: 'test-session',
    agentClient: mockClient as any,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() as any },
    turnAccumulator: new TurnItemAccumulator(),
  });

  composition.conversationStore.replaceHistory(history as any);
  if (ledgerCallIds.length > 0) {
    composition.toolTracker.beginTurn();
    for (const callId of ledgerCallIds) {
      composition.toolTracker.recordFunctionCall({ type: 'function_call', callId, name: 'shell', arguments: '{}' });
    }
  }
  const token = composition.generationGuard.capture();
  composition.approvalFlow.prepareContinuation = () =>
    ({
      pendingApprovalContext: {
        state: runState,
        interruption: runState.getInterruptions()[0],
        toolCallArgumentsById: new Map([['call-interrupted', '{}']]),
        emittedCommandIds: new Set<string>(),
        token,
        inputMode: 'delta',
        cumulativeUsage: {},
        cumulativeCommandMessages: [],
        cumulativeTurnItems: [],
      },
      toolStartedEvent: undefined,
      removeInterceptor: () => {},
    } as any);

  const outcome = await collect(
    composition.turnWorkflow.executeContinuation({
      kind: 'approval_decision',
      answer: 'y',
      generation: token,
    }),
  );

  return { outcome, receivedCallIds };
};

it('passes interrupted and completed parallel tool call ids to continuation', async () => {
  const { outcome, receivedCallIds } = await runResponseContinuation({
    runState: {
      getInterruptions: () => [{ callId: 'call-interrupted', name: 'shell', arguments: '{}' }],
      _generatedItems: [{ type: 'function_call_output', callId: 'call-completed-parallel', output: 'ok' }],
    },
  });

  expect((outcome as any).kind).toBe('response');
  expect(receivedCallIds?.sort()).toEqual(['call-completed-parallel', 'call-interrupted']);
});

it('excludes generated tool outputs already consumed in conversation history', async () => {
  const { outcome, receivedCallIds } = await runResponseContinuation({
    runState: {
      getInterruptions: () => [{ callId: 'call-interrupted', name: 'shell', arguments: '{}' }],
      _generatedItems: [
        { type: 'function_call_output', callId: 'call-consumed', output: 'already sent' },
        { type: 'function_call_output', callId: 'call-new-parallel', output: 'new' },
      ],
    },
    history: [
      { role: 'user', type: 'message', content: 'hello' },
      { type: 'function_call', callId: 'call-consumed', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', callId: 'call-consumed', output: 'already sent' },
    ],
  });

  expect((outcome as any).kind).toBe('response');
  expect(receivedCallIds?.sort()).toEqual(['call-interrupted', 'call-new-parallel']);
});

it('uses only the current response cycle instead of the whole turn ledger', async () => {
  const { outcome, receivedCallIds } = await runResponseContinuation({
    runState: {
      getInterruptions: () => [{ callId: 'call-current', name: 'shell', arguments: '{}' }],
      _generatedItems: [],
    },
    ledgerCallIds: ['call-old'],
  });

  expect((outcome as any).kind).toBe('response');
  expect(receivedCallIds).toEqual(['call-current']);
});

it('keeps rejected and approved sibling ids during abort resolution', async () => {
  let receivedCallIds: string[] | undefined;
  const mockClient = {
    getProvider: () => 'openai',
    async continueRunStream(_state: unknown, options: { toolResultCallIds?: string[] }) {
      receivedCallIds = options.toolResultCallIds;
      const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'resolved' }]);
      stream.finalOutput = 'resolved';
      return stream;
    },
  };
  const composition = createSessionRuntimeInternals({
    sessionId: 'test-session',
    agentClient: mockClient as any,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() as any },
    turnAccumulator: new TurnItemAccumulator(),
  });
  const token = composition.generationGuard.capture();
  const interruptedState = {
    getInterruptions: () => [{ callId: 'call-rejected', name: 'shell', arguments: '{}' }],
    _generatedItems: [{ type: 'function_call_output', callId: 'call-approved', output: 'ok' }],
  };
  const abortedContext = {
    state: interruptedState,
    interruption: { callId: 'call-rejected', name: 'shell', arguments: '{}' },
    emittedCommandIds: new Set<string>(),
    toolCallArgumentsById: new Map<string, unknown>(),
    token,
    inputMode: 'delta' as const,
    cumulativeUsage: {},
    cumulativeCommandMessages: [],
    cumulativeTurnItems: [],
  };

  composition.approvalFlow.prepareAbortResolution = () => ({
    abortedContext: abortedContext as any,
    removeInterceptor: () => {},
  });

  const outcome = await collect(
    composition.turnWorkflow.executeContinuation({
      kind: 'abort_resolution',
      abortedContext: abortedContext as any,
      userText: 'continue with a new request',
      generation: token,
    }),
  );

  expect((outcome as any).kind).toBe('response');
  expect(receivedCallIds?.sort()).toEqual(['call-approved', 'call-rejected']);
});
