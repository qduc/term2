import type { BackgroundCheckInDueEvent } from '../conversation/conversation-events.js';
import type { BackgroundTask } from '../subagents/subagent-notification-store.js';

/** Current values of `agent.backgroundCheckIn.*`, read fresh on every tick. */
export interface BackgroundCheckInSettings {
  enabled: boolean;
  intervalMs: number;
  maxCheckInsPerTask: number;
}

export interface BackgroundCheckInSchedulerDeps {
  /** Snapshot of currently tracked background tasks, unified across executors. */
  getRunningTasks: () => readonly BackgroundTask[];
  /** Deliver a due check-in through the same pipeline as any other background event. */
  emit: (event: BackgroundCheckInDueEvent) => void;
  getSettings: () => BackgroundCheckInSettings;
  now?: () => number;
  setInterval?: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  /**
   * Poll granularity, independent of the configurable per-task `intervalMs`.
   * Coarser than the default 5-minute interval so a runtime change to
   * `intervalMs` takes effect without restarting a timer.
   */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 30_000;

interface CheckInProgress {
  lastCheckInAt: number;
  checkInCount: number;
}

function checkInKey(target: BackgroundCheckInDueEvent['target']): string {
  return `${target.kind}:${target.id}`;
}

function taskTarget(task: BackgroundTask): BackgroundCheckInDueEvent['target'] {
  return task.kind === 'shell' ? { kind: 'shell', id: task.jobId } : { kind: 'subagent', id: task.runId };
}

function taskDetails(task: BackgroundTask): BackgroundCheckInDueEvent['details'] {
  return task.kind === 'shell'
    ? { kind: 'shell', id: task.jobId, command: task.command }
    : {
        kind: 'subagent',
        id: task.runId,
        ...(task.name !== undefined ? { name: task.name } : {}),
        role: task.role,
        task: task.task,
      };
}

/**
 * Periodically checks whether any still-running background task (shell job or
 * async subagent) is due a proactive check-in, and emits one `background_
 * check_in_due` event per due task through the existing settlement-
 * notification pipeline (see docs/plans/background-work-control/agent-checkin.md).
 *
 * Owns no execution state of its own — `getRunningTasks` reads the unified
 * task snapshot the notification store already maintains. Per-task due time
 * and check-in count live only here, keyed by `${kind}:${id}`, and are
 * dropped the moment a task leaves the running snapshot (settled or evicted),
 * so a reused id after a task's lifecycle epoch bumps starts a fresh count.
 */
export class BackgroundCheckInScheduler {
  #getRunningTasks: () => readonly BackgroundTask[];
  #emit: (event: BackgroundCheckInDueEvent) => void;
  #getSettings: () => BackgroundCheckInSettings;
  #now: () => number;
  #clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #progress = new Map<string, CheckInProgress>();

  constructor(deps: BackgroundCheckInSchedulerDeps) {
    this.#getRunningTasks = deps.getRunningTasks;
    this.#emit = deps.emit;
    this.#getSettings = deps.getSettings;
    this.#now = deps.now ?? (() => Date.now());
    const setIntervalFn = deps.setInterval ?? setInterval;
    this.#clearInterval = deps.clearInterval ?? clearInterval;
    this.#timer = setIntervalFn(() => this.tick(), deps.tickMs ?? DEFAULT_TICK_MS);
    this.#timer.unref?.();
  }

  /** Exposed for tests; production callers rely on the internal timer. */
  tick(): void {
    const settings = this.#getSettings();
    const runningTasks = this.#getRunningTasks().filter((task) => task.status === 'running');
    const liveKeys = new Set(runningTasks.map((task) => checkInKey(taskTarget(task))));
    for (const key of this.#progress.keys()) {
      if (!liveKeys.has(key)) this.#progress.delete(key);
    }
    if (!settings.enabled) return;

    const now = this.#now();
    for (const task of runningTasks) {
      const target = taskTarget(task);
      const key = checkInKey(target);
      const progress = this.#progress.get(key);
      const dueAt = (progress?.lastCheckInAt ?? task.startedAt) + settings.intervalMs;
      if (now < dueAt) continue;
      const checkInIndex = (progress?.checkInCount ?? 0) + 1;
      if (checkInIndex > settings.maxCheckInsPerTask) continue;
      this.#progress.set(key, { lastCheckInAt: now, checkInCount: checkInIndex });
      this.#emit({
        type: 'background_check_in_due',
        target,
        checkInIndex,
        elapsedMs: now - task.startedAt,
        details: taskDetails(task),
      });
    }
  }

  dispose(): void {
    if (this.#timer === undefined) return;
    this.#clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
