import { describe, expect, it, vi } from 'vitest';
import { BackgroundCheckInScheduler } from './background-check-in-scheduler.js';
import type {
  BackgroundShellTask,
  BackgroundSubagentTask,
  BackgroundTask,
} from '../subagents/subagent-notification-store.js';

const shellTask = (overrides: Partial<BackgroundShellTask> = {}): BackgroundTask => ({
  kind: 'shell',
  jobId: 'shell-1',
  command: 'pnpm test',
  status: 'running',
  startedAt: 0,
  ...overrides,
});

const subagentTask = (overrides: Partial<BackgroundSubagentTask> = {}): BackgroundTask => ({
  kind: 'subagent',
  runId: 'run-1',
  role: 'explorer',
  task: 'inspect the project',
  status: 'running',
  startedAt: 0,
  ...overrides,
});

function makeScheduler(options: {
  tasks: () => readonly BackgroundTask[];
  settings?: Partial<{ enabled: boolean; intervalMs: number }>;
  getSubagentStatus?: (runId: string) => any;
  getShellJob?: (jobId: string) => any;
  getShellOutputTail?: (jobId: string, maxBytes?: number) => any;
  now: () => number;
}) {
  const emit = vi.fn();
  const noopInterval = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
  const scheduler = new BackgroundCheckInScheduler({
    getRunningTasks: options.tasks,
    emit,
    getSubagentStatus: options.getSubagentStatus,
    getShellJob: options.getShellJob,
    getShellOutputTail: options.getShellOutputTail,
    getSettings: () => ({
      enabled: true,
      intervalMs: 300_000,
      ...options.settings,
    }),
    now: options.now,
    setInterval: () => noopInterval,
    clearInterval: vi.fn(),
  });
  return { scheduler, emit };
}

describe('BackgroundCheckInScheduler', () => {
  it('does not fire before the interval has elapsed', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({ tasks: () => [shellTask()], now: () => time });

    time = 299_999;
    scheduler.tick();

    expect(emit).not.toHaveBeenCalled();
  });

  it('fires once the interval has elapsed, carrying task identity and elapsed time', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({ tasks: () => [shellTask()], now: () => time });

    time = 300_000;
    scheduler.tick();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'background_check_in_due',
      target: { kind: 'shell', id: 'shell-1' },
      checkInIndex: 1,
      elapsedMs: 300_000,
      details: { kind: 'shell', id: 'shell-1', command: 'pnpm test' },
    });
  });

  it('fires again only after another full interval, incrementing the check-in index', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({ tasks: () => [shellTask()], now: () => time });

    time = 300_000;
    scheduler.tick();
    time = 450_000;
    scheduler.tick();
    time = 600_000;
    scheduler.tick();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0]).toMatchObject({ checkInIndex: 2, elapsedMs: 600_000 });
  });

  it('continues firing without an artificial cap as long as task is running', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({
      tasks: () => [shellTask()],
      now: () => time,
    });

    for (let i = 1; i <= 5; i++) {
      time = i * 300_000;
      scheduler.tick();
      expect(emit).toHaveBeenCalledTimes(i);
      expect(emit.mock.calls[i - 1][0]).toMatchObject({ checkInIndex: i, elapsedMs: time });
    }
  });

  it('skips check-ins when a task is muted via setTaskPolicy', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({
      tasks: () => [shellTask()],
      now: () => time,
    });

    scheduler.setTaskPolicy({ kind: 'shell', id: 'shell-1' }, { enabled: false });

    time = 300_000;
    scheduler.tick();
    time = 600_000;
    scheduler.tick();

    expect(emit).not.toHaveBeenCalled();

    // Re-enabling allows check-ins to resume
    scheduler.setTaskPolicy({ kind: 'shell', id: 'shell-1' }, { enabled: true });
    scheduler.tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ checkInIndex: 1 }));
  });

  it('respects a custom per-task intervalMs', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({
      tasks: () => [shellTask()],
      now: () => time,
    });

    // Set 10-minute interval (600_000 ms)
    scheduler.setTaskPolicy({ kind: 'shell', id: 'shell-1' }, { intervalMs: 600_000 });

    time = 300_000;
    scheduler.tick();
    expect(emit).not.toHaveBeenCalled();

    time = 600_000;
    scheduler.tick();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('respects a custom one-off nextDueAt and resets to regular interval after firing', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({
      tasks: () => [shellTask()],
      now: () => time,
    });

    // Delay first check-in to 15 minutes (900_000 ms)
    scheduler.setTaskPolicy({ kind: 'shell', id: 'shell-1' }, { nextDueAt: 900_000 });

    time = 300_000;
    scheduler.tick();
    time = 600_000;
    scheduler.tick();
    expect(emit).not.toHaveBeenCalled();

    time = 900_000;
    scheduler.tick();
    expect(emit).toHaveBeenCalledTimes(1);

    // After firing, next one should be due at 900_000 + 300_000 = 1_200_000 ms
    time = 1_000_000;
    scheduler.tick();
    expect(emit).toHaveBeenCalledTimes(1);

    time = 1_200_000;
    scheduler.tick();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('configures task check-ins via configureTaskCheckIn and resolves aliases/names', () => {
    const time = 0;
    const sub = subagentTask({ runId: 'run-xyz', name: 'worker-1' });
    const { scheduler } = makeScheduler({
      tasks: () => [sub],
      now: () => time,
    });

    const notFound = scheduler.configureTaskCheckIn('unknown-job', { enabled: false });
    expect(notFound.ok).toBe(false);

    // Resolve by alias name
    const byName = scheduler.configureTaskCheckIn('worker-1', { intervalMs: 120_000, enabled: false });
    expect(byName.ok).toBe(true);
    expect(scheduler.getTaskPolicy({ kind: 'subagent', id: 'run-xyz' })).toEqual(
      expect.objectContaining({ enabled: false, intervalMs: 120_000 }),
    );

    // Resolve by canonical runId
    const byId = scheduler.configureTaskCheckIn('run-xyz', { enabled: true, nextDueInMs: 50_000 });
    expect(byId.ok).toBe(true);
    expect(scheduler.getTaskPolicy({ kind: 'subagent', id: 'run-xyz' })).toEqual(
      expect.objectContaining({ enabled: true, nextDueAt: 50_000 }),
    );
  });

  it('does nothing while disabled', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({
      tasks: () => [shellTask()],
      settings: { enabled: false },
      now: () => time,
    });

    time = 300_000;
    scheduler.tick();
    expect(emit).not.toHaveBeenCalled();
  });

  it('tracks distinct background tasks independently', () => {
    let time = 0;
    const shell = shellTask();
    const subagent = subagentTask({ startedAt: 100_000 });
    const { scheduler, emit } = makeScheduler({ tasks: () => [shell, subagent], now: () => time });

    time = 300_000;
    scheduler.tick();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'shell', id: 'shell-1' } }));

    time = 400_000;
    scheduler.tick();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { kind: 'subagent', id: 'run-1' },
        details: { kind: 'subagent', id: 'run-1', role: 'explorer', task: 'inspect the project' },
      }),
    );
  });

  it('forgets progress once a task leaves the running snapshot, restarting its count if it returns', () => {
    let time = 0;
    let tasks: readonly BackgroundTask[] = [shellTask()];
    const { scheduler, emit } = makeScheduler({ tasks: () => tasks, now: () => time });

    time = 300_000;
    scheduler.tick();
    expect(emit).toHaveBeenCalledTimes(1);

    tasks = [];
    time = 300_001;
    scheduler.tick();

    tasks = [shellTask({ startedAt: time })];
    time += 300_000;
    scheduler.tick();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0]).toMatchObject({ checkInIndex: 1 });
  });

  it('ignores tasks that are not running', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({
      tasks: () => [shellTask({ status: 'completed', completedAt: 0 })],
      now: () => time,
    });

    time = 1_000_000;
    scheduler.tick();

    expect(emit).not.toHaveBeenCalled();
  });

  it('fires for subagents with rich progress details when getSubagentStatus is provided', () => {
    let time = 0;
    const subagent = subagentTask({ runId: 'sub-1', role: 'worker', task: 'refactor tests' });
    const { scheduler, emit } = makeScheduler({
      tasks: () => [subagent],
      now: () => time,
      getSubagentStatus: (runId) =>
        runId === 'sub-1'
          ? {
              runId: 'sub-1',
              role: 'worker',
              status: 'running',
              task: 'refactor tests',
              taskPreview: 'refactor tests',
              startedAt: 0,
              elapsedMs: 300_000,
              activityState: 'active',
              toolCounts: { grep_search: 3, edit_file: 1 },
              lastToolName: 'edit_file',
              lastObservation: { kind: 'tool_started', at: 290_000, toolName: 'edit_file' },
              currentText: 'Modifying test suites to verify new behavior.',
            }
          : undefined,
    });

    time = 300_000;
    scheduler.tick();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'background_check_in_due',
      target: { kind: 'subagent', id: 'sub-1' },
      checkInIndex: 1,
      elapsedMs: 300_000,
      details: {
        kind: 'subagent',
        id: 'sub-1',
        role: 'worker',
        task: 'refactor tests',
        activity: {
          phase: 'active',
          lastObservation: { kind: 'tool_started', at: 290_000, toolName: 'edit_file' },
          liveness: { state: 'recent', lastObservedAt: 290_000, ageMs: 10_000 },
        },
        activityState: 'active',
        toolCounts: { grep_search: 3, edit_file: 1 },
        lastToolName: 'edit_file',
        lastObservation: { kind: 'tool_started', at: 290_000, toolName: 'edit_file' },
        latestNarrative: 'Modifying test suites to verify new behavior.',
      },
    });
  });

  it('carries waiting-provider and quiet evidence into a model-facing check-in', () => {
    let time = 0;
    const subagent = subagentTask({ runId: 'sub-quiet' });
    const { scheduler, emit } = makeScheduler({
      tasks: () => [subagent],
      now: () => time,
      getSubagentStatus: () => ({
        runId: 'sub-quiet',
        role: 'explorer',
        status: 'running',
        task: 'wait for provider',
        taskPreview: 'wait for provider',
        startedAt: 0,
        elapsedMs: 300_000,
        activityState: 'waiting',
        waitingReason: 'provider',
        lastActivityAt: 0,
        toolCounts: {},
      }),
    });

    time = 300_000;
    scheduler.tick();

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          activity: {
            phase: 'waiting',
            reason: 'provider',
            lastObservation: { kind: 'request_dispatched', at: 0 },
            liveness: { state: 'quiet', lastObservedAt: 0, ageMs: 300_000 },
          },
        }),
      }),
    );
  });

  it('populates rich shell job observation and status when getShellJob is provided', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({
      tasks: () => [shellTask({ jobId: 'shell-1' })],
      now: () => time,
      getShellJob: (jobId) =>
        jobId === 'shell-1'
          ? {
              id: 'shell-1',
              command: 'pnpm test',
              status: 'running',
              startedAt: 0,
              lastObservation: { kind: 'shell_output_received', at: 295_000 },
            }
          : undefined,
    });

    time = 300_000;
    scheduler.tick();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'background_check_in_due',
      target: { kind: 'shell', id: 'shell-1' },
      checkInIndex: 1,
      elapsedMs: 300_000,
      details: {
        kind: 'shell',
        id: 'shell-1',
        command: 'pnpm test',
        activity: {
          phase: 'active',
          lastObservation: { kind: 'shell_output_received', at: 295_000 },
          liveness: { state: 'recent', lastObservedAt: 295_000, ageMs: 5_000 },
        },
        status: 'running',
        lastObservation: { kind: 'shell_output_received', at: 295_000 },
      },
    });
  });

  it('populates outputTail when getShellOutputTail is provided', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({
      tasks: () => [shellTask({ jobId: 'shell-1' })],
      now: () => time,
      getShellOutputTail: (jobId) => (jobId === 'shell-1' ? '12/15 passed\nrunning test-4.ts' : undefined),
    });

    time = 300_000;
    scheduler.tick();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'background_check_in_due',
      target: { kind: 'shell', id: 'shell-1' },
      checkInIndex: 1,
      elapsedMs: 300_000,
      details: {
        kind: 'shell',
        id: 'shell-1',
        command: 'pnpm test',
        outputTail: '12/15 passed\nrunning test-4.ts',
      },
    });
  });

  it('disposes its internal timer exactly once', () => {
    const clearIntervalSpy = vi.fn();
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const scheduler = new BackgroundCheckInScheduler({
      getRunningTasks: () => [],
      emit: vi.fn(),
      getSettings: () => ({ enabled: true, intervalMs: 300_000, maxCheckInsPerTask: 3 }),
      setInterval: () => timer,
      clearInterval: clearIntervalSpy,
    });

    scheduler.dispose();
    scheduler.dispose();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });
});
