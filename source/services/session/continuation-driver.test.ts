// @ts-nocheck - ContinuationDriver tests use mock objects that don't satisfy RunState type
import test from 'ava';
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

function createMockStream() {
  return {
    finalOutput: 'Done.',
    newItems: [],
    history: [],
  };
}

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
    ...deps,
  });
}

// ── stale approval continuation ────────────────────────────────

test('stale approval continuation returns stale outcome', async (t) => {
  const driver = createDriver({
    generationGuard: { isCurrent: () => false } as any,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 0 }, new ManualApprovalDecisionPolicy()),
  );
  t.is(result.kind, 'stale');
});

// ── drive with no pending approval ─────────────────────────────

test('drive with no pending approval throws error', async (t) => {
  const driver = createDriver({
    planApplier: {
      prepareInit: () => {
        throw new Error('No pending approval for continuation');
      },
    } as any,
  });

  await t.throwsAsync(
    async () =>
      collectResult(
        driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
      ),
    { message: 'No pending approval for continuation' },
  );
});

// ── unrecoverable error ──────────────────────────────────────

test('drive yields error event when continuation stream throws unrecoverable error', async (t) => {
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
  t.is(errorEvents.length, 1);
  t.is(errorEvents[0]?.message, 'stream boom');
});

// ── continuation from rejection ───────────────────────────────

test('continuation from rejection records aborted approval in tool tracker', async (t) => {
  let recordedCallId: string | undefined;
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
  t.is(result.kind, 'response');
});

// ── continuation from approval decision ────────────────────────

test('continuation from approval decision returns final response', async (t) => {
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

  t.is(result.kind, 'response');
  if (result.kind === 'response') {
    t.is(result.result.type, 'response');
    t.is(result.result.finalText, 'Done.');
  }
});

// ── continuation from approval emits deduplicated tool_started ─

test('continuation from approval emits deduplicated tool_started event', async (t) => {
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
  t.is(toolStarted.length, 1);
  if (toolStarted[0] && toolStarted[0].type === 'tool_started') {
    t.is(toolStarted[0].toolCallId, 'call-tool-1');
  }
});

// ── nested approval emits subagent_tool_started ───────────────

test('continuation from nested approval emits one subagent_tool_started and no parent tool_started', async (t) => {
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
  t.is(toolStarted.length, 0);
  t.is(subagentStarted.length, 1);
  if (subagentStarted[0] && subagentStarted[0].type === 'subagent_tool_started') {
    t.is(subagentStarted[0].toolCallId, 'nested-tool-1');
  }
});

// ── drive returns approval_required when policy says prompt ───

test('drive returns approval_required when policy says prompt', async (t) => {
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

  t.is(result.kind, 'approval_required');
  if (result.kind === 'approval_required') {
    t.is(result.result.approval.toolName, 'apply_patch');
  }
  t.deepEqual(recordedApproval, {
    toolName: 'apply_patch',
    argumentsText: 'patch',
    callId: 'call-3',
    llmAdvisory: undefined,
  });
});

test('driver preserves the initial ledger snapshot and records a prompted approval', async (t) => {
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

  t.is(result.kind, 'approval_required');
  t.deepEqual(
    (initialSnapshot as Array<{ callId: string }>).map((entry) => entry.callId),
    ['existing-call'],
  );
  t.deepEqual(
    toolTracker.export().map((entry) => entry.callId),
    ['existing-call', 'pending-call'],
  );
});

// ── multiple auto-approved interruptions ─────────────────────

test('multiple auto-approved interruptions followed by manual approval', async (t) => {
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

  t.is(result.kind, 'approval_required');
  if (result.kind === 'approval_required') {
    t.is(result.result.approval.toolName, 'apply_patch');
    t.is(result.result.approval.callId, 'call-3');
  }
  t.is(cycleCount, 3);
});

// ── abort resolution ──────────────────────────────────────────

test('continuation from abort resolution drives stream and returns result', async (t) => {
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

  t.is(result.kind, 'response');
});

// ── fresh_start_required ─────────────────────────────────────

test('recovery returns fresh_start_required', async (t) => {
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

  t.is(result.kind, 'fresh_start_required');
  if (result.kind === 'fresh_start_required') {
    t.is(result.retryCounts.transientRetryCount, 1);
    t.is(result.delayMs, 100);
  }
});

// ── rejection preserves event order and ledger state ─────────

test('rejection preserves event order and ledger state', async (t) => {
  let abortedCallId: string | undefined;
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

  t.is(result.kind, 'response');
  const toolStarted = events.filter((e) => e.type === 'tool_started');
  t.is(toolStarted.length, 0);
});
