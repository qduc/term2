import { it, expect } from 'vitest';
import { ContinuationPlanApplier } from './continuation-plan-applier.js';

function createMockToolTracker() {
  return {
    argumentsById: new Map<string, unknown>(),
    clearArguments: () => {},
    export: () => [] as any[],
    dedupeToolStarted: (event: any) => event,
    recordAbortedApproval: () => {},
    recordFunctionCall: () => {},
    activeCallIdsForCurrentTurn: () => [] as string[],
  };
}

function createMockDeps(): any {
  const tracker = createMockToolTracker();
  return {
    approvalFlow: {
      prepareContinuation: () => null as any,
      prepareAbortResolution: () => ({ removeInterceptor: () => {} } as any),
    },
    toolTracker: tracker,
    logger: { debug: () => {}, getCorrelationId: () => undefined },
    sessionId: 'test-session',
  };
}

it('prepareInit throws when no pending approval for approval_decision', () => {
  const deps = createMockDeps();
  deps.approvalFlow.prepareContinuation = () => null;

  const applier = new ContinuationPlanApplier(deps);

  expect(() =>
    applier.prepareInit({
      kind: 'approval_decision',
      answer: 'y',
      generation: 1,
    }),
  ).toThrow('No pending approval for continuation');
});

it('prepareInit returns prepared continuation for approval_decision', () => {
  const deps = createMockDeps();
  deps.approvalFlow.prepareContinuation = () => ({
    pendingApprovalContext: {
      state: { id: 's1' },
      interruption: { callId: 'c1' },
      toolCallArgumentsById: new Map([['k1', 'v1']]),
      emittedCommandIds: new Set<string>(['id1']),
      token: 5,
      inputMode: 'full_history',
      cumulativeUsage: { promptTokens: 10 } as any,
      cumulativeCommandMessages: [{ id: 'm1' } as any],
      cumulativeTurnItems: [{ type: 'text' } as any],
    },
    toolStartedEvent: { type: 'tool_started', toolCallId: 'c1' },
    removeInterceptor: () => {},
  });

  const applier = new ContinuationPlanApplier(deps);
  const prepared = applier.prepareInit({
    kind: 'approval_decision',
    answer: 'y',
    generation: 1,
  });

  expect(prepared.source).toBe('continueRunStream');
  expect(prepared.token).toBe(5);
  expect(prepared.inputMode).toBe('full_history');
  expect((prepared.toolStartedEvent as any).type).toBe('tool_started');
});

it('prepareInit records aborted approval for rejection', () => {
  const deps = createMockDeps();
  let abortedCallId: string | undefined;
  deps.toolTracker.recordAbortedApproval = (_output: string, _output2: string, callId: string | undefined) => {
    abortedCallId = callId;
  };

  deps.approvalFlow.prepareContinuation = () => ({
    pendingApprovalContext: {
      state: { id: 's1' },
      interruption: { callId: 'c1' },
      toolCallArgumentsById: new Map(),
      emittedCommandIds: new Set<string>(),
    },
    removeInterceptor: () => {},
  });

  const applier = new ContinuationPlanApplier(deps);
  applier.prepareInit({
    kind: 'approval_decision',
    answer: 'n',
    rejectionReason: 'too risky',
    generation: 1,
  });

  expect(abortedCallId).toBe('c1');
});

it('prepareInit returns prepared continuation for abort_resolution', () => {
  const deps = createMockDeps();
  deps.approvalFlow.prepareAbortResolution = (_context: any, _text: string) => ({
    removeInterceptor: () => {},
  });

  const applier = new ContinuationPlanApplier(deps);
  const prepared = applier.prepareInit({
    kind: 'abort_resolution',
    abortedContext: {
      state: { id: 's1' },
      interruption: { callId: 'c1' },
      emittedCommandIds: new Set<string>(),
      toolCallArgumentsById: new Map(),
      token: 3,
      inputMode: 'delta',
      cumulativeUsage: undefined,
      cumulativeCommandMessages: undefined,
      cumulativeTurnItems: undefined,
    } as any,
    userText: 'hello',
    generation: 1,
  });

  expect(prepared.source).toBe('abortResolution');
  expect(prepared.token).toBe(3);
  expect(prepared.toolStartedEvent).toBe(undefined);
});

it('applyInitialSetup yields deduped tool_started event', async () => {
  const deps = createMockDeps();
  deps.toolTracker.dedupeToolStarted = (event: any) => event;

  const applier = new ContinuationPlanApplier(deps);
  const events: any[] = [];
  const prepared = {
    toolStartedEvent: { type: 'tool_started', toolCallId: 'c1' },
    toolCallArgumentsById: new Map(),
  } as any;
  const state = { setLedgerSnapshot: () => {} } as any;

  for await (const event of applier.applyInitialSetup(prepared, state)) {
    events.push(event);
  }

  expect(events.length).toBe(1);
  expect(events[0].type).toBe('tool_started');
});

it('applyInitialSetup populates toolTracker argumentsById', async () => {
  const deps = createMockDeps();
  const applier = new ContinuationPlanApplier(deps);
  const prepared = {
    toolStartedEvent: undefined,
    toolCallArgumentsById: new Map([['k1', 'v1']]),
  } as any;
  const state = { setLedgerSnapshot: () => {} } as any;

  for await (const _ of applier.applyInitialSetup(prepared, state)) {
    // no events
  }

  expect(deps.toolTracker.argumentsById.get('k1')).toBe('v1');
});

it('applyInitialSetup captures the current tool ledger for recovery', async () => {
  const deps = createMockDeps();
  const snapshot = [{ callId: 'existing-call', status: 'completed' }];
  deps.toolTracker.export = () => snapshot;

  let capturedSnapshot: unknown;
  const state = {
    setLedgerSnapshot: (value: unknown) => {
      capturedSnapshot = value;
    },
  } as any;
  const prepared = {
    toolStartedEvent: undefined,
    toolCallArgumentsById: new Map(),
  } as any;

  const applier = new ContinuationPlanApplier(deps);
  for await (const _ of applier.applyInitialSetup(prepared, state)) {
    // no events
  }

  expect(capturedSnapshot).toBe(snapshot);
});

it('recordPendingApproval adds the pending function call to the tool ledger', () => {
  const deps = createMockDeps();
  let recordedItem: unknown;
  deps.toolTracker.recordFunctionCall = (item: unknown) => {
    recordedItem = item;
  };

  const applier = new ContinuationPlanApplier(deps);
  applier.recordPendingApproval({
    toolName: 'apply_patch',
    argumentsText: '{"patch":"content"}',
    callId: 'call-pending',
  });

  expect(recordedItem).toEqual({
    type: 'function_call',
    callId: 'call-pending',
    name: 'apply_patch',
    arguments: '{"patch":"content"}',
  });
});

it('applyNextPlan updates state for approved plan', async () => {
  const deps = createMockDeps();
  const applier = new ContinuationPlanApplier(deps);

  const state = {
    advanceFromPlan: (
      nextState: any,
      nextInterruption: any,
      nextInputMode: any,
      mergedIds: any,
      ledger: any,
      currentCallIds: any,
    ) => {
      expect(nextState.id).toBe('s2');
      expect(nextInterruption.callId).toBe('c2');
      expect(nextInputMode).toBe('full_history');
      expect(mergedIds).toEqual(new Set(['id1']));
      expect(ledger).toEqual([]);
      expect(currentCallIds).toEqual([]);
    },
  } as any;

  const nextPlan = {
    pendingApprovalContext: {
      state: { id: 's2' },
      interruption: { callId: 'c2' },
      toolCallArgumentsById: new Map(),
      inputMode: 'full_history',
    },
    toolStartedEvent: undefined,
  } as any;

  for await (const _ of applier.applyNextPlan(nextPlan, state, new Set(['id1']), true)) {
    // no events
  }
});

it('applyNextPlan records aborted approval for rejected plan', async () => {
  const deps = createMockDeps();
  let abortedCallId: string | undefined;
  deps.toolTracker.recordAbortedApproval = (_output: string, _output2: string, callId: string | undefined) => {
    abortedCallId = callId;
  };

  const applier = new ContinuationPlanApplier(deps);
  const state = {
    advanceFromPlan: () => {},
  } as any;

  const nextPlan = {
    pendingApprovalContext: {
      state: { id: 's2' },
      interruption: { callId: 'c2' },
      toolCallArgumentsById: new Map(),
    },
    toolStartedEvent: undefined,
  } as any;

  for await (const _ of applier.applyNextPlan(nextPlan, state, new Set(), false)) {
    // no events
  }

  expect(abortedCallId).toBe('c2');
});

it('applyNextPlan passes ledger-derived currentCallIds to advanceFromPlan', async () => {
  const deps = createMockDeps();
  deps.toolTracker.activeCallIdsForCurrentTurn = () => ['call-a', 'call-rejected'];
  deps.toolTracker.export = () => [{ callId: 'call-a', status: 'completed' }] as any;

  let receivedCallIds: string[] | undefined;
  const applier = new ContinuationPlanApplier(deps);
  const state = {
    advanceFromPlan: (
      _nextState: any,
      _nextInterruption: any,
      _nextInputMode: any,
      _mergedIds: any,
      _ledger: any,
      currentCallIds: string[],
    ) => {
      receivedCallIds = currentCallIds;
    },
  } as any;

  const nextPlan = {
    pendingApprovalContext: {
      state: { id: 's2' },
      interruption: { callId: 'call-rejected' },
      toolCallArgumentsById: new Map(),
    },
    toolStartedEvent: undefined,
  } as any;

  for await (const _ of applier.applyNextPlan(nextPlan, state, new Set(), false)) {
    // no events
  }

  // Includes the aborted sibling (call-rejected) because the ledger has no
  // status filter — provider APIs require an output for every tool call.
  expect(receivedCallIds).toEqual(['call-a', 'call-rejected']);
});
