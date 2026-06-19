import { it, expect } from 'vitest';
import { ContinuationDriver } from './continuation-driver.js';
import { ManualApprovalDecisionPolicy, ShellAutoApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ContinuationPlanApplier } from './continuation-plan-applier.js';

const collectResult = async (
  gen: AsyncGenerator<
    import('../conversation/conversation-events.js').ConversationEvent,
    import('./continuation-driver.js').ContinuationDriveResult,
    void
  >,
): Promise<{
  events: import('../conversation/conversation-events.js').ConversationEvent[];
  result: import('./continuation-driver.js').ContinuationDriveResult;
}> => {
  const events: import('../conversation/conversation-events.js').ConversationEvent[] = [];
  let result: import('./continuation-driver.js').ContinuationDriveResult;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }
  return { events, result };
};

function createDriver(deps: any) {
  return new ContinuationDriver({
    generationGuard: { isCurrent: () => true } as any,
    logger: { debug: () => {}, getCorrelationId: () => undefined, error: () => {}, warn: () => {} } as any,
    sessionId: 'test-session',
    shellAutoApproval: { shouldAutoApprove: () => false } as any,
    inputPlanner: { recordSuccess: () => {} } as any,
    conversationStore: { getHistory: () => [] } as any,
    approvalFlow: {
      getPending: () => null,
      prepareContinuation: () => null,
      prepareAbortResolution: () => ({ removeInterceptor: () => {} }),
    } as any,
    planApplier: {
      prepareInit: (init: any) => ({
        state: {},
        interruption: { callId: 'call-init' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
        inputMode: 'delta',
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* () {},
      recordPendingApproval: () => {},
    } as any,
    shellAutoApproval: {
      shouldAutoApprove: () => true,
      resolveAdvisoryForInterruption: async () => ({
        shouldApprove: true,
        model: 'test-model',
        reasoning: 'test approval',
      }),
    } as any,
    streamCycle: {
      async *execute(_state: any) {
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
    recoveryHandler: {
      async *handle() {
        return { kind: 'terminated' };
      },
    } as any,
    toolTracker: {
      activeCallIdsForCurrentTurn: () => [] as string[],
    } as any,
    ...deps,
  });
}

// ── stale approval continuation ────────────────────────────────

it('stale approval continuation returns stale outcome', async () => {
  const driver = createDriver({
    generationGuard: { isCurrent: () => false } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 0 }, new ManualApprovalDecisionPolicy()),
  );
  expect(result.kind).toBe('stale');
});

// ── drive with no pending approval ─────────────────────────────

it('drive with no pending approval throws error', async () => {
  const driver = createDriver({
    planApplier: {
      prepareInit: () => {
        throw new Error('No pending approval for continuation');
      },
    } as any,
  });

  await expect(async () =>
    collectResult(
      driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
    ),
  ).rejects.toThrow('No pending approval for continuation');
});

// ── unrecoverable error ──────────────────────────────────────

it('drive yields error event when continuation stream throws unrecoverable error', async () => {
  const driver = createDriver({
    streamCycle: {
      async *execute() {
        throw new Error('stream boom');
      },
    } as any,
    recoveryHandler: {
      async *handle() {
        return { kind: 'terminated' };
      },
    } as any,
  });

  let events: import('../conversation/conversation-events.js').ConversationEvent[] = [];
  const gen = driver.drive(
    { kind: 'approval_decision', answer: 'y', generation: 1 },
    new ManualApprovalDecisionPolicy(),
  );
  try {
    while (true) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value);
    }
  } catch {
    // expected to throw after yielding error event
  }

  const errorEvents = events.filter((e) => e.type === 'error');
  expect(errorEvents.length).toBe(1);
  expect(errorEvents[0]?.message).toBe('stream boom');
});

it('drive preserves already-approved parallel call ids when staging remaining approvals', async () => {
  const callA = { callId: 'call-a', name: 'shell', arguments: '{"command":"git status --short"}' };
  const callB = { callId: 'call-b', name: 'shell', arguments: '{"command":"rg options source"}' };
  const approved = new Set<string>();
  let retargeted: any = null;
  const seenCallIds: string[][] = [];

  const makeState = (interruptions: any[]) => ({
    getInterruptions: () => interruptions,
    _context: {
      isToolApproved: ({ callId }: { callId: string }) => (approved.has(callId) ? true : undefined),
    },
  });

  const driver = createDriver({
    approvalFlow: {
      getPending: () => null,
      retargetPendingInterruption: (interruption: any) => {
        retargeted = interruption;
      },
      prepareContinuation: () => {
        if (!retargeted) return null;
        approved.add(retargeted.callId);
        const remaining = [callA, callB].filter((interruption) => !approved.has(interruption.callId));
        return {
          pendingApprovalContext: {
            state: makeState(remaining),
            interruption: retargeted,
            toolCallArgumentsById: new Map(),
            emittedCommandIds: new Set(),
            inputMode: 'delta',
          },
          removeInterceptor: () => {},
        };
      },
      prepareAbortResolution: () => ({ removeInterceptor: () => {} }),
    } as any,
    planApplier: {
      prepareInit: (init: any) => ({
        state: makeState([callA, callB]),
        interruption: callA,
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
        inputMode: 'delta',
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* (nextPlan: any, state: any, mergedEmittedIds: Set<string>) {
        state.advanceFromPlan(
          nextPlan.pendingApprovalContext.state,
          nextPlan.pendingApprovalContext.interruption,
          nextPlan.pendingApprovalContext.inputMode,
          mergedEmittedIds,
          [],
          state.currentCallIds,
        );
      },
      recordPendingApproval: () => {},
    } as any,
    streamCycle: {
      async *execute(state: any) {
        seenCallIds.push([...state.currentCallIds]);
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, { decide: async () => 'approve' }),
  );

  expect(result.kind).toBe('response');
  expect(seenCallIds).toEqual([['call-a', 'call-b']]);
});

// ── continuation from rejection ───────────────────────────────

it('continuation from rejection records aborted approval in tool tracker', async () => {
  const driver = createDriver({
    planApplier: {
      prepareInit: (init: any) => ({
        state: {},
        interruption: { callId: 'call-reject' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* () {},
    } as any,
    streamCycle: {
      async *execute() {
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive(
      { kind: 'approval_decision', answer: 'n', rejectionReason: 'too risky', generation: 1 },
      new ManualApprovalDecisionPolicy(),
    ),
  );
  expect(result.kind).toBe('response');
});

// ── continuation from approval decision ────────────────────────

it('continuation from approval decision returns final response', async () => {
  const driver = createDriver({
    streamCycle: {
      async *execute() {
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  expect(result.kind).toBe('response');
  if (result.kind === 'response') {
    expect(result.terminal.type).toBe('response');
    expect((result.terminal as { finalText: string }).finalText).toBe('Done.');
  }
});

// ── continuation from approval emits deduplicated tool_started ─

it('continuation from approval emits deduplicated tool_started event', async () => {
  const startedEvent = { type: 'tool_started', toolCallId: 'call-tool-1', toolName: 'shell' };
  const driver = createDriver({
    planApplier: {
      prepareInit: (init: any) => ({
        state: {},
        interruption: { callId: 'call-tool-1' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        toolStartedEvent: startedEvent,
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
      }),
      applyInitialSetup: async function* () {
        yield startedEvent;
      },
      applyNextPlan: async function* () {},
    } as any,
  });

  const { events } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  const toolStarted = events.filter((e) => e.type === 'tool_started');
  expect(toolStarted.length).toBe(1);
  if (toolStarted[0] && toolStarted[0].type === 'tool_started') {
    expect(toolStarted[0].toolCallId).toBe('call-tool-1');
  }
});

// ── nested approval emits subagent_tool_started ───────────────

it('continuation from nested approval emits one subagent_tool_started and no parent tool_started', async () => {
  const startedEvent = {
    type: 'subagent_tool_started',
    agentId: 'worker-1',
    role: 'worker',
    toolCallId: 'nested-tool-1',
    toolName: 'shell',
  };
  const driver = createDriver({
    planApplier: {
      prepareInit: (init: any) => ({
        state: {},
        interruption: { callId: 'nested-tool-1', name: 'shell', agent: { name: 'CLI Agent' } },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        toolStartedEvent: startedEvent,
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
      }),
      applyInitialSetup: async function* () {
        yield startedEvent;
      },
      applyNextPlan: async function* () {},
    } as any,
  });

  const { events } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  const toolStarted = events.filter((e) => e.type === 'tool_started');
  const subagentStarted = events.filter((e) => e.type === 'subagent_tool_started');
  expect(toolStarted.length).toBe(0);
  expect(subagentStarted.length).toBe(1);
  if (subagentStarted[0] && subagentStarted[0].type === 'subagent_tool_started') {
    expect(subagentStarted[0].toolCallId).toBe('nested-tool-1');
  }
});

// ── drive returns approval_required when policy says prompt ───

it('drive returns approval_required when policy says prompt', async () => {
  let recordedApproval: unknown;
  const driver = createDriver({
    planApplier: {
      prepareInit: (init: any) => ({
        state: {},
        interruption: { callId: 'call-init' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
        inputMode: 'delta',
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* () {},
      recordPendingApproval: (approval: unknown) => {
        recordedApproval = approval;
      },
    } as any,
    streamCycle: {
      async *execute() {
        return {
          kind: 'completed',
          outcome: {
            kind: 'approval_required',
            result: {
              type: 'approval_required',
              approval: {
                agentName: 'Agent',
                toolName: 'apply_patch',
                argumentsText: 'patch',
                callId: 'call-3',
              },
            },
          },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  expect(result.kind).toBe('approval_required');
  if (result.kind === 'approval_required') {
    expect((result.terminal as { approval: { toolName: string } }).approval.toolName).toBe('apply_patch');
  }
  expect(recordedApproval).toEqual({
    toolName: 'apply_patch',
    argumentsText: 'patch',
    callId: 'call-3',
    llmAdvisory: undefined,
  });
});

it('driver preserves the initial ledger snapshot and records a prompted approval', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  toolTracker.recordFunctionCall({
    type: 'function_call',
    callId: 'existing-call',
    name: 'shell',
    arguments: '{"command":"pwd"}',
  });

  const approvalFlow = {
    getPending: () => null,
    prepareContinuation: () => ({
      pendingApprovalContext: {
        state: {},
        interruption: { callId: 'initial-call' },
        toolCallArgumentsById: new Map(),
        emittedCommandIds: new Set(),
        inputMode: 'delta',
      },
      removeInterceptor: () => {},
    }),
  } as any;
  const logger = {
    debug: () => {},
    getCorrelationId: () => undefined,
    error: () => {},
    warn: () => {},
  } as any;
  const planApplier = new ContinuationPlanApplier({
    approvalFlow,
    toolTracker,
    logger,
    sessionId: 'test-session',
  });

  let initialSnapshot: unknown;
  const driver = createDriver({
    approvalFlow,
    logger,
    conversationStore,
    planApplier,
    streamCycle: {
      async *execute(state: any) {
        initialSnapshot = state.ledgerSnapshot;
        return {
          kind: 'completed',
          outcome: {
            kind: 'approval_required',
            result: {
              type: 'approval_required',
              approval: {
                agentName: 'Agent',
                toolName: 'apply_patch',
                argumentsText: '{"patch":"content"}',
                callId: 'pending-call',
              },
            },
          },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  expect(result.kind).toBe('approval_required');
  expect((initialSnapshot as Array<{ callId: string }>).map((entry) => entry.callId)).toEqual(['existing-call']);
  expect(toolTracker.export().map((entry) => entry.callId)).toEqual(['existing-call', 'pending-call']);
});

// Regression (concern 2): function calls recorded by InitialStreamCycle before
// the continuation driver runs must appear in currentCallIds. The ledger is
// populated synchronously during stream iteration, which completes before
// ContinuationDriver.drive() reads it, so a fresh read captures them.
it('continuation derives currentCallIds from the current response cycle, not the whole turn ledger', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  // Simulate earlier response cycles in the same assistant turn. These call IDs
  // must not be sent again when previous_response_id chaining continues.
  toolTracker.beginTurn();
  toolTracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_old_1', callId: 'call-old-1', name: 'read_file', arguments: '{}' },
  });
  toolTracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_old_2', callId: 'call-old-2', name: 'shell', arguments: '{}' },
  });
  toolTracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_current', callId: 'call-current', name: 'apply_patch', arguments: '{}' },
  });

  let resumedCallIds: string[] | undefined;
  const runState = {
    getInterruptions: () => [{ callId: 'call-current', name: 'apply_patch', arguments: '{}' }],
  };
  const driver = createDriver({
    toolTracker,
    planApplier: {
      prepareInit: (init: any) => ({
        state: runState,
        interruption: { callId: 'call-current' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
        inputMode: 'delta',
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* () {},
      recordPendingApproval: () => {},
    } as any,
    streamCycle: {
      async *execute(state: any) {
        resumedCallIds = [...state.currentCallIds];
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  expect(result.kind).toBe('response');
  expect(resumedCallIds).toEqual(['call-current']);
});

it('continuation derives currentCallIds including completed parallel tool calls from _generatedItems', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  toolTracker.beginTurn();

  let resumedCallIds: string[] | undefined;
  const runState = {
    getInterruptions: () => [{ callId: 'call-interrupted', name: 'shell', arguments: '{}' }],
    _generatedItems: [{ type: 'function_call_output', callId: 'call-completed-parallel', output: 'ok' }],
  };
  const driver = createDriver({
    toolTracker,
    planApplier: {
      prepareInit: (init: any) => ({
        state: runState,
        interruption: { callId: 'call-interrupted' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
        inputMode: 'delta',
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* () {},
      recordPendingApproval: () => {},
    } as any,
    streamCycle: {
      async *execute(state: any) {
        resumedCallIds = [...state.currentCallIds];
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  expect(result.kind).toBe('response');
  expect(resumedCallIds?.sort()).toEqual(['call-completed-parallel', 'call-interrupted']);
});

it('continuation derives currentCallIds excluding already consumed tool calls in history', async () => {
  const conversationStore = new ConversationStore();
  // Add a consumed tool call result to the history
  conversationStore.replaceHistory([
    { role: 'user', type: 'message', content: 'hello' },
    { type: 'function_call', callId: 'call-consumed', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', callId: 'call-consumed', output: 'already sent' },
  ] as any);

  const toolTracker = new SessionToolTracker(conversationStore);
  toolTracker.beginTurn();

  let resumedCallIds: string[] | undefined;
  const runState = {
    getInterruptions: () => [{ callId: 'call-interrupted', name: 'shell', arguments: '{}' }],
    _generatedItems: [
      { type: 'function_call_output', callId: 'call-consumed', output: 'already sent' },
      { type: 'function_call_output', callId: 'call-new-parallel', output: 'new' },
    ],
  };
  const driver = createDriver({
    toolTracker,
    conversationStore,
    planApplier: {
      prepareInit: (init: any) => ({
        state: runState,
        interruption: { callId: 'call-interrupted' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
        inputMode: 'delta',
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* () {},
      recordPendingApproval: () => {},
    } as any,
    streamCycle: {
      async *execute(state: any) {
        resumedCallIds = [...state.currentCallIds];
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  expect(result.kind).toBe('response');
  expect(resumedCallIds?.sort()).toEqual(['call-interrupted', 'call-new-parallel']);
});

it('auto-approved follow-up continuations keep only the next response cycle call IDs', async () => {
  let cycleCount = 0;
  const firstRunState = {
    getInterruptions: () => [{ callId: 'call-first', name: 'shell', arguments: '{}' }],
  };
  const secondRunState = {
    getInterruptions: () => [{ callId: 'call-second', name: 'apply_patch', arguments: '{}' }],
  };
  const driver = createDriver({
    toolTracker: {
      activeCallIdsForCurrentTurn: () => ['call-old', 'call-first', 'call-second'],
      export: () => [],
    } as any,
    approvalFlow: {
      prepareContinuation: () => ({
        pendingApprovalContext: {
          state: secondRunState,
          interruption: { callId: 'call-second' },
          toolCallArgumentsById: new Map(),
          emittedCommandIds: new Set(),
          inputMode: 'delta',
        },
        removeInterceptor: () => {},
      }),
      getPending: () => null,
    } as any,
    planApplier: {
      prepareInit: (init: any) => ({
        state: firstRunState,
        interruption: { callId: 'call-first' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
        inputMode: 'delta',
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* (_nextPlan: any, state: any) {
        state.currentState = secondRunState;
        state.currentCallIds = ['call-old', 'call-first', 'call-second'];
      },
      recordPendingApproval: () => {},
    } as any,
    streamCycle: {
      async *execute(state: any) {
        cycleCount++;
        if (cycleCount === 1) {
          expect(state.currentCallIds).toEqual(['call-first']);
          return {
            kind: 'completed',
            outcome: {
              kind: 'auto_approve',
              advisory: { model: 'm', reasoning: 'safe', approved: true, source: 'llm' },
              callId: 'call-second',
              argumentsText: '{}',
            },
            nextCumulativeMessages: [],
            nextCumulativeTurnItems: [],
            mergedEmittedIds: new Set(),
          };
        }
        expect(state.currentCallIds).toEqual(['call-second']);
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive(
      { kind: 'approval_decision', answer: 'y', generation: 1 },
      new ShellAutoApprovalDecisionPolicy(driver as any),
    ),
  );

  expect(result.kind).toBe('response');
  expect(cycleCount).toBe(2);
});

// ── multiple auto-approved interruptions ─────────────────────

it('multiple auto-approved interruptions followed by manual approval', async () => {
  let cycleCount = 0;
  const driver = createDriver({
    shellAutoApproval: {
      shouldAutoApprove: () => true,
      resolveAdvisoryForInterruption: async () => ({
        model: 'mock-model',
        reasoning: 'auto-approvable',
        approved: true,
        source: 'llm',
      }),
    } as any,
    streamCycle: {
      async *execute() {
        cycleCount++;
        if (cycleCount <= 2) {
          return {
            kind: 'completed',
            outcome: {
              kind: 'auto_approve',
              advisory: { model: 'm', reasoning: 'safe', approved: true, source: 'llm' },
              callId: `call-${cycleCount}`,
              argumentsText: 'ls',
            },
            nextCumulativeMessages: [],
            nextCumulativeTurnItems: [],
            mergedEmittedIds: new Set(),
          };
        }
        return {
          kind: 'completed',
          outcome: {
            kind: 'approval_required',
            result: {
              type: 'approval_required',
              approval: {
                agentName: 'Agent',
                toolName: 'apply_patch',
                argumentsText: 'patch',
                callId: 'call-3',
              },
            },
          },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
    approvalFlow: {
      getPending: () => null,
      prepareContinuation: () => ({
        pendingApprovalContext: {
          state: {},
          interruption: { callId: `call-${cycleCount}` },
          toolCallArgumentsById: new Map(),
          emittedCommandIds: new Set(),
          inputMode: 'delta',
        },
        removeInterceptor: () => {},
      }),
    } as any,
  });

  const policy = new ShellAutoApprovalDecisionPolicy(driver as any);
  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, policy),
  );

  expect(result.kind).toBe('approval_required');
  if (result.kind === 'approval_required') {
    expect((result.terminal as { approval: { toolName: string } }).approval.toolName).toBe('apply_patch');
    expect((result.terminal as { approval: { callId: string } }).approval.callId).toBe('call-3');
  }
  expect(cycleCount).toBe(3);
});

it('parallel approval batch is fully decided before the continuation stream resumes', async () => {
  const interruptions = [
    { name: 'shell', callId: 'call-1', arguments: { command: 'pwd' } },
    { name: 'shell', callId: 'call-2', arguments: { command: 'ls' } },
    { name: 'shell', callId: 'call-3', arguments: { command: 'git status --short' } },
  ];
  const decisions = new Map<string, boolean | undefined>([['call-1', true]]);
  const runState = {
    getInterruptions: () => interruptions,
    _context: {
      isToolApproved: ({ callId }: { callId: string }) => decisions.get(callId),
    },
  };
  let pending = { state: runState, interruption: interruptions[0] } as any;
  let streamExecutions = 0;
  let resumedCallIds: string[] = [];

  const driver = createDriver({
    // The ledger is cumulative: every call decided for the turn appears in
    // activeCallIdsForCurrentTurn. Mirror that by returning all decided calls.
    toolTracker: {
      activeCallIdsForCurrentTurn: () => [...decisions.keys()],
    } as any,
    shellAutoApproval: {
      resolveAdvisoryForInterruption: async () => ({
        model: 'mock-model',
        reasoning: 'safe',
        approved: true,
        source: 'llm',
      }),
      shouldAutoApprove: () => true,
    } as any,
    approvalFlow: {
      getPending: () => pending,
      retargetPendingInterruption: (interruption: any) => {
        pending = { ...pending, interruption };
        return pending;
      },
      prepareContinuation: () => {
        decisions.set(pending.interruption.callId, true);
        return {
          pendingApprovalContext: pending,
          removeInterceptor: () => {},
        };
      },
    } as any,
    planApplier: {
      prepareInit: (init: any) => ({
        state: runState,
        interruption: interruptions[0],
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
        inputMode: 'delta',
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* () {},
      recordPendingApproval: () => {},
    } as any,
    streamCycle: {
      async *execute(state: any) {
        streamExecutions++;
        resumedCallIds = [...state.currentCallIds];
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }));

  expect(result.kind).toBe('response');
  expect(decisions).toEqual(
    new Map<string, boolean>([
      ['call-1', true],
      ['call-2', true],
      ['call-3', true],
    ]),
  );
  expect(streamExecutions).toBe(1);
  expect(resumedCallIds).toEqual(['call-1', 'call-2', 'call-3']);
});

it('parallel approval batch prompts for unresolved siblings without resuming the stream', async () => {
  const interruptions = [
    { name: 'shell', callId: 'call-1', arguments: { command: 'pwd' } },
    { name: 'shell', callId: 'call-2', arguments: { command: 'git log --all' } },
  ];
  const decisions = new Map<string, boolean | undefined>([['call-1', true]]);
  const runState = {
    getInterruptions: () => interruptions,
    _context: {
      isToolApproved: ({ callId }: { callId: string }) => decisions.get(callId),
    },
  };
  let pending = { state: runState, interruption: interruptions[0] } as any;
  let streamExecutions = 0;

  const driver = createDriver({
    shellAutoApproval: {
      resolveAdvisoryForInterruption: async () => ({
        model: 'mock-model',
        reasoning: 'needs review',
        approved: false,
        source: 'llm',
      }),
      shouldAutoApprove: () => false,
    } as any,
    approvalFlow: {
      getPending: () => pending,
      retargetPendingInterruption: (interruption: any) => {
        pending = { ...pending, interruption };
        return pending;
      },
    } as any,
    planApplier: {
      prepareInit: (init: any) => ({
        state: runState,
        interruption: interruptions[0],
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
        inputMode: 'delta',
      }),
      applyInitialSetup: async function* () {},
      recordPendingApproval: () => {},
    } as any,
    streamCycle: {
      async *execute() {
        streamExecutions++;
        throw new Error('stream should not resume while a sibling decision is pending');
      },
    } as any,
  });

  const { result } = await collectResult(driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }));

  expect(result.kind).toBe('approval_required');
  if (result.kind === 'approval_required') {
    expect((result.terminal as any).approval.callId).toBe('call-2');
  }
  expect(pending.interruption).toBe(interruptions[1]);
  expect(streamExecutions).toBe(0);
});

// ── abort resolution ──────────────────────────────────────────

it('continuation from abort resolution drives stream and returns result', async () => {
  const driver = createDriver({
    planApplier: {
      prepareInit: (init: any) => ({
        state: {},
        interruption: { callId: 'call-abort' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'abortResolution',
        token: init.generation,
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* () {},
    } as any,
  });

  const { result } = await collectResult(
    driver.drive(
      {
        kind: 'abort_resolution',
        abortedContext: {
          state: {},
          interruption: {},
          emittedCommandIds: new Set(),
          toolCallArgumentsById: new Map(),
        } as any,
        userText: 'hello',
        generation: 1,
      },
      new ManualApprovalDecisionPolicy(),
    ),
  );

  expect(result.kind).toBe('response');
});

it('abort resolution derives currentCallIds from the aborted approval record, not the ledger', async () => {
  // The ledger's current turn is empty for abort resolution (a new turn was
  // begun), so the rejected call's ID must come from the abort record itself.
  let resumedCallIds: string[] | undefined;
  const driver = createDriver({
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
    planApplier: {
      prepareInit: (init: any) => ({
        state: {},
        interruption: init.abortedContext.interruption,
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'abortResolution',
        token: init.generation,
      }),
      applyInitialSetup: async function* () {},
    } as any,
    streamCycle: {
      async *execute(state: any) {
        resumedCallIds = [...state.currentCallIds];
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive({
      kind: 'abort_resolution',
      abortedContext: {
        state: {},
        interruption: { callId: 'call-abort' },
        emittedCommandIds: new Set(),
        toolCallArgumentsById: new Map(),
      } as any,
      userText: 'new input',
      generation: 1,
    }),
  );

  expect(result.kind).toBe('response');
  expect(resumedCallIds).toEqual(['call-abort']);
});

it('abort resolution keeps sibling call IDs for a rejected tool in a parallel batch', async () => {
  let resumedCallIds: string[] | undefined;
  const interruptedTurn = {
    getInterruptions: () => [{ name: 'shell', callId: 'call-rejected', arguments: { command: 'git status --short' } }],
    _generatedItems: [{ type: 'function_call_output', callId: 'call-approved', output: 'working tree clean' }],
  };

  const driver = createDriver({
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
    streamCycle: {
      async *execute(state: any) {
        resumedCallIds = [...state.currentCallIds];
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive(
      {
        kind: 'abort_resolution',
        abortedContext: {
          state: interruptedTurn as any,
          interruption: { callId: 'call-rejected' },
          emittedCommandIds: new Set(),
          toolCallArgumentsById: new Map(),
          token: 1,
          inputMode: 'delta',
        } as any,
        userText: 'new input',
        generation: 1,
      },
      new ManualApprovalDecisionPolicy(),
    ),
  );

  expect(result.kind).toBe('response');
  expect(resumedCallIds?.sort()).toEqual(['call-approved', 'call-rejected']);
});

// ── fresh_start_required ─────────────────────────────────────

it('recovery returns fresh_start_required', async () => {
  const driver = createDriver({
    streamCycle: {
      async *execute() {
        throw new Error('transient');
      },
    } as any,
    recoveryHandler: {
      async *handle() {
        return {
          kind: 'fresh_start',
          retryCounts: {
            transientRetryCount: 1,
            serviceTierFallbackCount: 0,
            modelRetryCount: 0,
            transportDowngradeCount: 0,
          },
          delayMs: 100,
        };
      },
    } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  expect(result.kind).toBe('fresh_start_required');
  if (result.kind === 'fresh_start_required') {
    expect(result.retryCounts.transientRetryCount).toBe(1);
    expect(result.delayMs).toBe(100);
  }
});

// ── rejection preserves event order and ledger state ─────────

it('rejection preserves event order and ledger state', async () => {
  const driver = createDriver({
    planApplier: {
      prepareInit: (init: any) => ({
        state: {},
        interruption: { callId: 'call-reject' },
        toolCallArgumentsById: new Map(),
        previouslyEmittedCommandIds: new Set(),
        removeInterceptor: () => {},
        source: 'continueRunStream',
        token: init.generation,
      }),
      applyInitialSetup: async function* () {},
      applyNextPlan: async function* () {},
    } as any,
    streamCycle: {
      async *execute() {
        return {
          kind: 'completed',
          outcome: { kind: 'response', result: { type: 'response', finalText: 'Done.', commandMessages: [] } },
          nextCumulativeMessages: [],
          nextCumulativeTurnItems: [],
          mergedEmittedIds: new Set(),
        };
      },
    } as any,
  });

  const { events, result } = await collectResult(
    driver.drive(
      { kind: 'approval_decision', answer: 'n', rejectionReason: 'too risky', generation: 1 },
      new ManualApprovalDecisionPolicy(),
    ),
  );

  expect(result.kind).toBe('response');
  const toolStarted = events.filter((e) => e.type === 'tool_started');
  expect(toolStarted.length).toBe(0);
});
