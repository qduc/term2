import type { BackgroundCheckInDueEvent } from '../conversation/conversation-events.js';
import type { BackgroundTask } from '../subagents/subagent-notification-store.js';
import type { SubagentRunStatus } from '../subagents/types.js';
import type { BackgroundShellJob } from '../shell/background-shell-registry.js';
import { truncatePreview } from '../subagents/utils.js';
import {
  BACKGROUND_SHELL_QUIET_AFTER_MS,
  BACKGROUND_SUBAGENT_QUIET_AFTER_MS,
  normalizeBackgroundTaskActivity,
} from '../background-task-activity.js';

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
  getSubagentStatus?: (runId: string) => SubagentRunStatus | undefined;
  getShellJob?: (jobId: string) => BackgroundShellJob<unknown> | undefined;
  getShellOutputTail?: (jobId: string, maxBytes?: number) => string | undefined;
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

function taskDetails(
  task: BackgroundTask,
  deps: {
    getSubagentStatus?: (runId: string) => SubagentRunStatus | undefined;
    getShellJob?: (jobId: string) => BackgroundShellJob<unknown> | undefined;
    getShellOutputTail?: (jobId: string, maxBytes?: number) => string | undefined;
  },
  now: number,
): BackgroundCheckInDueEvent['details'] {
  if (task.kind === 'shell') {
    const job = deps.getShellJob?.(task.jobId);
    const rawTail = deps.getShellOutputTail?.(task.jobId, 400)?.trim();
    const outputTail = rawTail && rawTail.length > 0 ? rawTail : undefined;
    return {
      kind: 'shell',
      id: task.jobId,
      command: task.command,
      ...(job?.lastObservation || job?.lastActivityAt !== undefined
        ? {
            activity: normalizeBackgroundTaskActivity({
              status: job?.status ?? task.status,
              ...(job?.lastObservation === undefined
                ? { lastActivityAt: job?.lastActivityAt }
                : { lastObservation: job.lastObservation }),
              now,
              quietAfterMs: BACKGROUND_SHELL_QUIET_AFTER_MS,
            }),
          }
        : {}),
      ...(job?.status ? { status: job.status } : {}),
      ...(job?.lastObservation ? { lastObservation: job.lastObservation } : {}),
      ...(outputTail ? { outputTail } : {}),
    };
  }

  const subagentStatus = deps.getSubagentStatus?.(task.runId);
  const narrative =
    subagentStatus?.currentText?.trim() ||
    (subagentStatus?.turnHistory && subagentStatus.turnHistory.length > 0
      ? subagentStatus.turnHistory[subagentStatus.turnHistory.length - 1]?.text?.trim()
      : undefined);
  const latestNarrative = narrative ? truncatePreview(narrative) : undefined;

  return {
    kind: 'subagent',
    id: task.runId,
    ...(task.name !== undefined ? { name: task.name } : {}),
    role: task.role,
    task: task.task,
    ...(subagentStatus?.lastObservation || subagentStatus?.lastActivityAt !== undefined
      ? {
          activity: normalizeBackgroundTaskActivity({
            status: subagentStatus.status,
            activityState:
              subagentStatus.status === 'awaiting_approval' || subagentStatus.status === 'waiting_for_answer'
                ? 'waiting'
                : subagentStatus.activityState,
            waitingReason:
              subagentStatus.status === 'awaiting_approval'
                ? 'approval'
                : subagentStatus.status === 'waiting_for_answer'
                ? 'answer'
                : subagentStatus.waitingReason,
            ...(subagentStatus.lastObservation === undefined
              ? { lastActivityAt: subagentStatus.lastActivityAt }
              : { lastObservation: subagentStatus.lastObservation }),
            now,
            quietAfterMs: BACKGROUND_SUBAGENT_QUIET_AFTER_MS,
          }),
        }
      : {}),
    ...(subagentStatus?.activityState ? { activityState: subagentStatus.activityState } : {}),
    ...(subagentStatus?.waitingReason ? { waitingReason: subagentStatus.waitingReason } : {}),
    ...(subagentStatus?.toolCounts && Object.keys(subagentStatus.toolCounts).length > 0
      ? { toolCounts: subagentStatus.toolCounts }
      : {}),
    ...(subagentStatus?.lastToolName
      ? { lastToolName: subagentStatus.lastToolName }
      : task.lastTool?.label
      ? { lastToolName: task.lastTool.label }
      : {}),
    ...(subagentStatus?.lastObservation ? { lastObservation: subagentStatus.lastObservation } : {}),
    ...(latestNarrative ? { latestNarrative } : {}),
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
  #getSubagentStatus?: (runId: string) => SubagentRunStatus | undefined;
  #getShellJob?: (jobId: string) => BackgroundShellJob<unknown> | undefined;
  #getShellOutputTail?: (jobId: string, maxBytes?: number) => string | undefined;
  #now: () => number;
  #clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #progress = new Map<string, CheckInProgress>();

  constructor(deps: BackgroundCheckInSchedulerDeps) {
    this.#getRunningTasks = deps.getRunningTasks;
    this.#emit = deps.emit;
    this.#getSettings = deps.getSettings;
    this.#getSubagentStatus = deps.getSubagentStatus;
    this.#getShellJob = deps.getShellJob;
    this.#getShellOutputTail = deps.getShellOutputTail;
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
        details: taskDetails(
          task,
          {
            getSubagentStatus: this.#getSubagentStatus,
            getShellJob: this.#getShellJob,
            getShellOutputTail: this.#getShellOutputTail,
          },
          now,
        ),
      });
    }
  }

  dispose(): void {
    if (this.#timer === undefined) return;
    this.#clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
