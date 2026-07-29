import { expect, it } from 'vitest';
import { createSessionRuntimeInternals as createProductionSessionRuntimeInternals } from './session-composition.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';

const createSessionRuntimeInternals = (
  options: Omit<Parameters<typeof createProductionSessionRuntimeInternals>[0], 'toolOwnership'>,
) => createProductionSessionRuntimeInternals({ ...options, toolOwnership: new ToolOwnershipRegistry() });

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
};

const runResponseContinuation = async ({
  runState,
  history = [],
  startedLedgerCallIds = [],
  completedResultCallIds = [],
  previousResponseId,
}: {
  runState: ContinuationRunState;
  history?: unknown[];
  startedLedgerCallIds?: string[];
  completedResultCallIds?: string[];
  previousResponseId?: string;
}) => {
  let receivedCallIds: string[] | undefined;
  let receivedKnownCallIds: readonly string[] | undefined;
  let receivedPreviousResponseId: string | null | undefined;
  let receivedProviderHistorySnapshot: unknown;

  const mockClient = {
    getProvider: () => 'openai',
    async continueRunStream(
      _state: unknown,
      options: {
        previousResponseId?: string | null;
        toolResultCallIds?: string[];
        knownToolCallIds?: readonly string[];
        providerHistorySnapshot?: unknown;
      },
    ) {
      receivedCallIds = options.toolResultCallIds;
      receivedKnownCallIds = options.knownToolCallIds;
      receivedPreviousResponseId = options.previousResponseId;
      receivedProviderHistorySnapshot = options.providerHistorySnapshot;
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
  composition.providerContinuity.update(previousResponseId ?? null);
  if (startedLedgerCallIds.length > 0 || completedResultCallIds.length > 0) {
    composition.toolTracker.beginTurn();
    for (const callId of [...startedLedgerCallIds, ...completedResultCallIds]) {
      composition.toolTracker.recordFunctionCall({ type: 'function_call', callId, name: 'shell', arguments: '{}' });
    }
    for (const callId of completedResultCallIds) {
      composition.toolTracker.recordFunctionResult({ type: 'function_call_output', callId, output: 'ok' });
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
    } as any);

  const outcome = await collect(
    composition.turnWorkflow.executeContinuation({
      kind: 'approval_decision',
      answer: 'y',
      generation: token,
    }),
  );

  return {
    outcome,
    receivedCallIds,
    receivedKnownCallIds,
    receivedPreviousResponseId,
    receivedProviderHistorySnapshot,
    composition,
  };
};

it('passes interrupted and completed parallel tool call ids to continuation', async () => {
  const { outcome, receivedCallIds } = await runResponseContinuation({
    runState: {
      getInterruptions: () => [{ callId: 'call-interrupted', name: 'shell', arguments: '{}' }],
    },
    completedResultCallIds: ['call-completed-parallel'],
  });

  expect((outcome as any).kind).toBe('response');
  expect(receivedCallIds?.sort()).toEqual(['call-completed-parallel', 'call-interrupted']);
});

it('excludes completed tool outputs already consumed in conversation history', async () => {
  const { outcome, receivedCallIds } = await runResponseContinuation({
    runState: {
      getInterruptions: () => [{ callId: 'call-interrupted', name: 'shell', arguments: '{}' }],
    },
    completedResultCallIds: ['call-consumed', 'call-new-parallel'],
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
    },
    startedLedgerCallIds: ['call-old'],
  });

  expect((outcome as any).kind).toBe('response');
  expect(receivedCallIds).toEqual(['call-current']);
});

it('includes current-turn calls among calls known to the chained response', async () => {
  const { outcome, receivedKnownCallIds } = await runResponseContinuation({
    runState: {
      getInterruptions: () => [{ callId: 'call-current', name: 'shell', arguments: '{}' }],
    },
    completedResultCallIds: ['call-current'],
    history: [{ type: 'function_call', callId: 'call-earlier', name: 'shell', arguments: '{}' }],
  });

  expect((outcome as any).kind).toBe('response');
  expect(receivedKnownCallIds ? [...receivedKnownCallIds].sort() : undefined).toEqual(['call-current', 'call-earlier']);
});

it('passes the authoritative history snapshot without changing continuation options', async () => {
  const history = [{ type: 'function_call', callId: 'call-earlier', name: 'shell', arguments: '{}' }];
  const {
    outcome,
    receivedCallIds,
    receivedKnownCallIds,
    receivedPreviousResponseId,
    receivedProviderHistorySnapshot,
    composition,
  } = await runResponseContinuation({
    runState: {
      getInterruptions: () => [{ callId: 'call-current', name: 'shell', arguments: '{}' }],
    },
    history,
    completedResultCallIds: ['call-current'],
    previousResponseId: 'response-before-approval',
  });

  expect((outcome as any).kind).toBe('response');
  expect(receivedPreviousResponseId).toBe('response-before-approval');
  expect(receivedCallIds?.sort()).toEqual(['call-current']);
  expect(receivedKnownCallIds ? [...receivedKnownCallIds].sort() : undefined).toEqual(['call-current', 'call-earlier']);
  expect(receivedProviderHistorySnapshot).toMatchObject(composition.conversationStore.getProviderHistorySnapshot());
  expect(Object.isFrozen(receivedProviderHistorySnapshot)).toBe(true);
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
  };
  composition.toolTracker.beginTurn();
  composition.toolTracker.recordFunctionCall({
    type: 'function_call',
    callId: 'call-approved',
    name: 'shell',
    arguments: '{}',
  });
  composition.toolTracker.recordFunctionResult({ type: 'function_call_output', callId: 'call-approved', output: 'ok' });
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
