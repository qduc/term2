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
  settings?: Partial<{ enabled: boolean; intervalMs: number; maxCheckInsPerTask: number }>;
  getSubagentStatus?: (runId: string) => any;
  getShellJob?: (jobId: string) => any;
  now: () => number;
}) {
  const emit = vi.fn();
  const noopInterval = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
  const scheduler = new BackgroundCheckInScheduler({
    getRunningTasks: options.tasks,
    emit,
    getSubagentStatus: options.getSubagentStatus,
    getShellJob: options.getShellJob,
    getSettings: () => ({
      enabled: true,
      intervalMs: 300_000,
      maxCheckInsPerTask: 3,
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

  it('stops firing once the per-task cap is reached', () => {
    let time = 0;
    const { scheduler, emit } = makeScheduler({
      tasks: () => [shellTask()],
      settings: { maxCheckInsPerTask: 1 },
      now: () => time,
    });

    time = 300_000;
    scheduler.tick();
    time = 600_000;
    scheduler.tick();
    time = 900_000;
    scheduler.tick();

    expect(emit).toHaveBeenCalledTimes(1);
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
        activityState: 'active',
        toolCounts: { grep_search: 3, edit_file: 1 },
        lastToolName: 'edit_file',
        lastObservation: { kind: 'tool_started', at: 290_000, toolName: 'edit_file' },
        latestNarrative: 'Modifying test suites to verify new behavior.',
      },
    });
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
        status: 'running',
        lastObservation: { kind: 'shell_output_received', at: 295_000 },
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
