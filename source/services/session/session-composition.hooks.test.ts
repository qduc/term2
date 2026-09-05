import { describe, expect, it, vi } from 'vitest';
import { createSessionRuntime as createProductionSessionRuntime } from './session-composition.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import type { BackgroundSubagentApprovalPauseSink } from '../subagents/foreground-subagent-lease.js';
import { HookEventFactory } from '../hooks/hook-event-factory.js';
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import type { StatusChangeHookEvent, Term2HookEvent } from '../hooks/hook-contracts.js';
import type { SubagentRunStatus } from '../subagents/types.js';
import type { BackgroundShellJob } from '../shell/background-shell-registry.js';
import { MockStream } from '../test-helpers/mock-stream.js';

const createSessionRuntime = (options: Omit<Parameters<typeof createProductionSessionRuntime>[0], 'toolOwnership'>) =>
  createProductionSessionRuntime({
    ...options,
    toolOwnership: new ToolOwnershipRegistry(),
    approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
  });

const noop = () => {};

const makeLogger = () => ({
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  setCorrelationId: noop,
  getCorrelationId: () => undefined,
  clearCorrelationId: noop,
});

const sessionContextService = {
  runWithContext: (_ctx: any, fn: () => any) => fn(),
  getContext: () => null,
};

type Sinks = {
  turn: ((event: ConversationEvent) => void) | null;
  background: ((event: ConversationEvent) => void) | null;
  shell: ((event: ConversationEvent) => void) | null;
  approval: BackgroundSubagentApprovalPauseSink | null;
};

const makeClient = (sinks: Sinks, overrides: Record<string, unknown> = {}) =>
  ({
    async startStream(_input: any, _opts: any) {
      const stream = new MockStream([{ type: 'text_delta', text: 'done' }]);
      stream.finalOutput = 'done';
      return stream;
    },
    abort: noop,
    continueRunStream: noop as any,
    setModel: noop as any,
    addToolInterceptor: noop as any,
    chat: noop as any,
    setSubagentEventSink: (sink: ((event: ConversationEvent) => void) | null) => {
      sinks.turn = sink;
    },
    setBackgroundSubagentEventSink: (sink: ((event: ConversationEvent) => void) | null) => {
      sinks.background = sink;
    },
    setBackgroundShellEventSink: (sink: ((event: ConversationEvent) => void) | null) => {
      sinks.shell = sink;
    },
    setBackgroundSubagentApprovalPauseSink: (sink: BackgroundSubagentApprovalPauseSink | null) => {
      sinks.approval = sink;
    },
    listBackgroundSubagentStatuses: () => [],
    listBackgroundShellJobs: () => [],
    ...overrides,
  } as unknown as ConversationAgentClient);

describe('session-composition public hook status with background tasks', () => {
  it('keeps public status working when foreground turn finishes but background subagent is running', async () => {
    const sinks: Sinks = { turn: null, background: null, shell: null, approval: null };
    let subagentStatuses: SubagentRunStatus[] = [
      {
        runId: 'sub-1',
        role: 'explorer',
        status: 'running',
        task: 'search codebase',
        taskPreview: 'search codebase',
        startedAt: 1000,
        elapsedMs: 50,
        toolCounts: {},
      },
    ];

    const emittedHookEvents: Term2HookEvent[] = [];
    const hookLifecycle: HookLifecyclePort = {
      emit: vi.fn(async (event: Term2HookEvent) => {
        emittedHookEvents.push(event);
      }),
      shutdown: vi.fn(async () => {}),
    };
    const hookEvents = new HookEventFactory({ sessionId: 'hook-subagent-test' });

    const runtime = createSessionRuntime({
      sessionId: 'hook-subagent-test',
      agentClient: makeClient(sinks, {
        listBackgroundSubagentStatuses: () => subagentStatuses,
      }),
      deps: { logger: makeLogger(), sessionContextService },
      hookLifecycle,
      hookEvents,
    });

    // 1. Run a foreground turn
    for await (const _event of runtime.turns.start('spawn subagent')) {
      // drain
    }

    const statusChanges = emittedHookEvents.filter((e): e is StatusChangeHookEvent => e.type === 'status.change');

    // Turned working on turn start, but did NOT transition to idle on turn completion because subagent is running
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]).toMatchObject({
      previous: 'idle',
      current: 'working',
      reason: 'turn_started',
    });

    // 2. Subagent completes
    subagentStatuses = [
      {
        runId: 'sub-1',
        role: 'explorer',
        status: 'completed',
        task: 'search codebase',
        taskPreview: 'search codebase',
        startedAt: 1000,
        elapsedMs: 200,
        toolCounts: {},
      },
    ];
    sinks.background?.({
      type: 'subagent_completed',
      async: true,
      result: {
        agentId: 'sub-1',
        role: 'explorer',
        status: 'completed',
        finalText: 'found the code',
        filesChanged: [],
        toolsUsed: [],
      },
    });

    const statusChangesAfterCompletion = emittedHookEvents.filter(
      (e): e is StatusChangeHookEvent => e.type === 'status.change',
    );

    expect(statusChangesAfterCompletion).toHaveLength(2);
    expect(statusChangesAfterCompletion[1]).toMatchObject({
      previous: 'working',
      current: 'idle',
      reason: 'turn_finished',
    });

    runtime.dispose();
  });

  it('keeps public status working when foreground turn finishes but background shell is running', async () => {
    const sinks: Sinks = { turn: null, background: null, shell: null, approval: null };
    let shellJobs: BackgroundShellJob<unknown>[] = [
      {
        id: 'shell-1',
        command: 'pnpm test',
        status: 'running',
        startedAt: 1000,
      },
    ];

    const emittedHookEvents: Term2HookEvent[] = [];
    const hookLifecycle: HookLifecyclePort = {
      emit: vi.fn(async (event: Term2HookEvent) => {
        emittedHookEvents.push(event);
      }),
      shutdown: vi.fn(async () => {}),
    };
    const hookEvents = new HookEventFactory({ sessionId: 'hook-shell-test' });

    const runtime = createSessionRuntime({
      sessionId: 'hook-shell-test',
      agentClient: makeClient(sinks, {
        listBackgroundShellJobs: () => shellJobs,
      }),
      deps: { logger: makeLogger(), sessionContextService },
      hookLifecycle,
      hookEvents,
    });

    // 1. Run a foreground turn
    for await (const _event of runtime.turns.start('run background tests')) {
      // drain
    }

    const statusChanges = emittedHookEvents.filter((e): e is StatusChangeHookEvent => e.type === 'status.change');

    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]).toMatchObject({
      previous: 'idle',
      current: 'working',
      reason: 'turn_started',
    });

    // 2. Shell job completes
    shellJobs = [
      {
        id: 'shell-1',
        command: 'pnpm test',
        status: 'completed',
        startedAt: 1000,
        completedAt: 2000,
      },
    ];
    sinks.shell?.({
      type: 'background_shell_completed',
      jobId: 'shell-1',
      command: 'pnpm test',
      status: 'completed',
      output: 'ok',
    });

    const statusChangesAfterCompletion = emittedHookEvents.filter(
      (e): e is StatusChangeHookEvent => e.type === 'status.change',
    );

    expect(statusChangesAfterCompletion).toHaveLength(2);
    expect(statusChangesAfterCompletion[1]).toMatchObject({
      previous: 'working',
      current: 'idle',
      reason: 'turn_finished',
    });

    runtime.dispose();
  });

  it('transitions to waiting_for_approval when a background subagent requires approval', async () => {
    const sinks: Sinks = { turn: null, background: null, shell: null, approval: null };
    const subagentStatuses: SubagentRunStatus[] = [
      {
        runId: 'sub-2',
        role: 'worker',
        status: 'running',
        task: 'edit file',
        taskPreview: 'edit file',
        startedAt: 1000,
        elapsedMs: 50,
        toolCounts: {},
      },
    ];

    const emittedHookEvents: Term2HookEvent[] = [];
    const hookLifecycle: HookLifecyclePort = {
      emit: vi.fn(async (event: Term2HookEvent) => {
        emittedHookEvents.push(event);
      }),
      shutdown: vi.fn(async () => {}),
    };
    const hookEvents = new HookEventFactory({ sessionId: 'hook-subagent-approval-test' });

    const runtime = createSessionRuntime({
      sessionId: 'hook-subagent-approval-test',
      agentClient: makeClient(sinks, {
        listBackgroundSubagentStatuses: () => subagentStatuses,
      }),
      deps: { logger: makeLogger(), sessionContextService },
      hookLifecycle,
      hookEvents,
    });

    // Turn is idle, but subagent is running -> status should become working if turn started
    for await (const _event of runtime.turns.start('run worker')) {
      // drain
    }

    // Now background subagent pauses for approval
    sinks.approval?.({
      runId: 'sub-2',
      role: 'worker',
      generation: 1,
      interruption: { type: 'interruption', call_id: 'call-approval-1', name: 'write_to_file', arguments: '{}' },
      apply: () => true,
    });

    const statusChanges = emittedHookEvents.filter((e): e is StatusChangeHookEvent => e.type === 'status.change');

    expect(statusChanges).toHaveLength(2);
    expect(statusChanges[1]).toMatchObject({
      previous: 'working',
      current: 'waiting_for_approval',
      reason: 'approval_requested',
    });

    // Resolve the approval
    const snapshot = runtime.backgroundSubagentApprovals.getSnapshot();
    expect(snapshot.pendingCount).toBe(1);
    expect(snapshot.current).not.toBeNull();

    runtime.backgroundSubagentApprovals.resolve({
      revision: snapshot.revision,
      entry: snapshot.current!,
      decision: { answer: 'approved' },
    });

    const statusChangesAfterResolve = emittedHookEvents.filter(
      (e): e is StatusChangeHookEvent => e.type === 'status.change',
    );

    expect(statusChangesAfterResolve).toHaveLength(3);
    expect(statusChangesAfterResolve[2]).toMatchObject({
      previous: 'waiting_for_approval',
      current: 'working',
      reason: 'turn_started',
    });

    runtime.dispose();
  });

  it('tracks multiple concurrent background tasks and only reports idle when all settle', async () => {
    const sinks: Sinks = { turn: null, background: null, shell: null, approval: null };
    let subagentStatuses: SubagentRunStatus[] = [
      {
        runId: 'sub-multi',
        role: 'explorer',
        status: 'running',
        task: 'search',
        taskPreview: 'search',
        startedAt: 1000,
        elapsedMs: 50,
        toolCounts: {},
      },
    ];
    let shellJobs: BackgroundShellJob<unknown>[] = [
      {
        id: 'shell-multi',
        command: 'build.sh',
        status: 'running',
        startedAt: 1000,
      },
    ];

    const emittedHookEvents: Term2HookEvent[] = [];
    const hookLifecycle: HookLifecyclePort = {
      emit: vi.fn(async (event: Term2HookEvent) => {
        emittedHookEvents.push(event);
      }),
      shutdown: vi.fn(async () => {}),
    };
    const hookEvents = new HookEventFactory({ sessionId: 'hook-multi-test' });

    const runtime = createSessionRuntime({
      sessionId: 'hook-multi-test',
      agentClient: makeClient(sinks, {
        listBackgroundSubagentStatuses: () => subagentStatuses,
        listBackgroundShellJobs: () => shellJobs,
      }),
      deps: { logger: makeLogger(), sessionContextService },
      hookLifecycle,
      hookEvents,
    });

    for await (const _event of runtime.turns.start('launch both')) {
      // drain
    }

    // Still working because both are running
    expect(emittedHookEvents.filter((e): e is StatusChangeHookEvent => e.type === 'status.change')).toHaveLength(1);

    // 1. Shell settles first
    shellJobs = [
      {
        id: 'shell-multi',
        command: 'build.sh',
        status: 'completed',
        startedAt: 1000,
        completedAt: 1500,
      },
    ];
    sinks.shell?.({
      type: 'background_shell_completed',
      jobId: 'shell-multi',
      command: 'build.sh',
      status: 'completed',
      output: 'ok',
    });

    // Subagent is still running -> still working, no idle emitted
    expect(emittedHookEvents.filter((e): e is StatusChangeHookEvent => e.type === 'status.change')).toHaveLength(1);

    // 2. Subagent settles
    subagentStatuses = [
      {
        runId: 'sub-multi',
        role: 'explorer',
        status: 'completed',
        task: 'search',
        taskPreview: 'search',
        startedAt: 1000,
        elapsedMs: 600,
        toolCounts: {},
      },
    ];
    sinks.background?.({
      type: 'subagent_completed',
      async: true,
      result: {
        agentId: 'sub-multi',
        role: 'explorer',
        status: 'completed',
        finalText: 'done search',
        filesChanged: [],
        toolsUsed: [],
      },
    });

    // Now all background work settled -> transition to idle
    const statusChanges = emittedHookEvents.filter((e): e is StatusChangeHookEvent => e.type === 'status.change');
    expect(statusChanges).toHaveLength(2);
    expect(statusChanges[1]).toMatchObject({
      previous: 'working',
      current: 'idle',
      reason: 'turn_finished',
    });

    runtime.dispose();
  });
});
