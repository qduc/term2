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
