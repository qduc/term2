import test from 'ava';
import { ContinuationPlanApplier } from './continuation-plan-applier.js';

function createMockToolTracker() {
  return {
    argumentsById: new Map<string, unknown>(),
    clearArguments: () => {},
    export: () => [] as any[],
    dedupeToolStarted: (event: any) => event,
    recordAbortedApproval: () => {},
    recordFunctionCall: () => {},
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

test('prepareInit throws when no pending approval for approval_decision', (t) => {
  const deps = createMockDeps();
  deps.approvalFlow.prepareContinuation = () => null;

  const applier = new ContinuationPlanApplier(deps);
  t.throws(
    () =>
      applier.prepareInit({
        kind: 'approval_decision',
        answer: 'y',
        generation: 1,
      }),
    { message: 'No pending approval for continuation' },
  );
});

test('prepareInit returns prepared continuation for approval_decision', (t) => {
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

  t.is(prepared.source, 'continueRunStream');
  t.is(prepared.token, 5);
  t.is(prepared.inputMode, 'full_history');
  t.is((prepared.toolStartedEvent as any).type, 'tool_started');
});

test('prepareInit records aborted approval for rejection', (t) => {
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

  t.is(abortedCallId, 'c1');
});

test('prepareInit returns prepared continuation for abort_resolution', (t) => {
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

  t.is(prepared.source, 'abortResolution');
  t.is(prepared.token, 3);
  t.is(prepared.toolStartedEvent, undefined);
});

test('applyInitialSetup yields deduped tool_started event', async (t) => {
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

  t.is(events.length, 1);
  t.is(events[0].type, 'tool_started');
});

test('applyInitialSetup populates toolTracker argumentsById', async (t) => {
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

  t.is(deps.toolTracker.argumentsById.get('k1'), 'v1');
});

test('applyInitialSetup captures the current tool ledger for recovery', async (t) => {
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

  t.is(capturedSnapshot, snapshot);
});

test('recordPendingApproval adds the pending function call to the tool ledger', (t) => {
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

  t.deepEqual(recordedItem, {
    type: 'function_call',
    callId: 'call-pending',
    name: 'apply_patch',
    arguments: '{"patch":"content"}',
  });
});

test('applyNextPlan updates state for approved plan', async (t) => {
  const deps = createMockDeps();
  const applier = new ContinuationPlanApplier(deps);

  const state = {
    advanceFromPlan: (nextState: any, nextInterruption: any, nextInputMode: any, mergedIds: any, ledger: any) => {
      t.is(nextState.id, 's2');
      t.is(nextInterruption.callId, 'c2');
      t.is(nextInputMode, 'full_history');
      t.deepEqual(mergedIds, new Set(['id1']));
      t.deepEqual(ledger, []);
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

test('applyNextPlan records aborted approval for rejected plan', async (t) => {
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

  t.is(abortedCallId, 'c2');
});
