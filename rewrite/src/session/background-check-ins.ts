import type { DirectBackgroundTasks } from './background.js';
import type { DirectTaskId, DirectTaskState } from './background-types.js';

export type DirectBackgroundCheckInSettings = { readonly enabled: boolean; readonly intervalMs: number };
export type DirectBackgroundCheckInPolicy = {
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly nextDueInMs?: number;
};
export type DirectBackgroundCheckIn = {
  readonly type: 'background_check_in_due';
  readonly target: { readonly kind: 'shell' | 'subagent'; readonly id: DirectTaskId };
  readonly checkInIndex: number;
  readonly elapsedMs: number;
  readonly details: DirectTaskState;
};
type Policy = { enabled?: boolean; intervalMs?: number; nextDueAt?: number };
type Progress = { lastCheckInAt: number; count: number; startedAt: number };

/**
 * Advisory check-in scheduling only: never aborts, caps, restarts or releases a
 * task. Session owns the polling timer and routes due events into its normal
 * background-notification pipeline. Settings are read fresh on every tick;
 * policies are live-only, matching the source scheduler's session lifetime.
 */
export class DirectBackgroundCheckIns {
  readonly #tasks: DirectBackgroundTasks;
  readonly #settings: () => DirectBackgroundCheckInSettings;
  readonly #emit: (event: DirectBackgroundCheckIn) => void;
  readonly #now: () => number;
  readonly #policies = new Map<DirectTaskId, Policy>();
  readonly #progress = new Map<DirectTaskId, Progress>();

  constructor(options: {
    readonly tasks: DirectBackgroundTasks;
    readonly settings: () => DirectBackgroundCheckInSettings;
    readonly emit: (event: DirectBackgroundCheckIn) => void;
    readonly now?: () => number;
  }) {
    this.#tasks = options.tasks;
    this.#settings = options.settings;
    this.#emit = options.emit;
    this.#now = options.now ?? Date.now;
  }

  /** Resolve an active background task by canonical ID or its active alias. */
  configure(
    target: string,
    options: DirectBackgroundCheckInPolicy,
  ):
    | { readonly ok: true; readonly taskId: DirectTaskId }
    | { readonly ok: false; readonly code: 'not_active' | 'invalid_policy' } {
    const task = this.#tasks.get(target);
    if (!task || !eligible(task)) return { ok: false, code: 'not_active' };
    if (!validPolicy(options)) return { ok: false, code: 'invalid_policy' };
    const policy = this.#policies.get(task.taskId) ?? {};
    if (options.enabled !== undefined) policy.enabled = options.enabled;
    if (options.intervalMs !== undefined) policy.intervalMs = options.intervalMs;
    if (options.nextDueInMs !== undefined) policy.nextDueAt = this.#now() + options.nextDueInMs;
    this.#policies.set(task.taskId, policy);
    return { ok: true, taskId: task.taskId };
  }

  /** Emit at most one due notice per eligible task per poll, never a catch-up burst. */
  tick(): void {
    const tasks = this.#tasks.list().filter(eligible);
    const liveIds = new Set(tasks.map((task) => task.taskId));
    for (const id of this.#policies.keys()) if (!liveIds.has(id)) this.#policies.delete(id);
    for (const id of this.#progress.keys()) if (!liveIds.has(id)) this.#progress.delete(id);
    const settings = this.#settings();
    if (!settings.enabled) return;
    if (!Number.isFinite(settings.intervalMs) || settings.intervalMs <= 0)
      throw new Error('Invalid background check-in interval.');
    const now = this.#now();
    for (const task of tasks) this.#check(task, settings.intervalMs, now);
  }

  #check(task: DirectTaskState, defaultInterval: number, now: number): void {
    const policy = this.#policies.get(task.taskId);
    if (policy?.enabled === false) return;
    // A continued run under the same ID starts its check-ins over.
    const recorded = this.#progress.get(task.taskId);
    const progress = recorded?.startedAt === task.startedAt ? recorded : undefined;
    const dueAt =
      policy?.nextDueAt ?? (progress?.lastCheckInAt ?? task.startedAt) + (policy?.intervalMs ?? defaultInterval);
    if (now < dueAt) return;
    const count = (progress?.count ?? 0) + 1;
    this.#emit({
      type: 'background_check_in_due',
      target: { kind: task.kind, id: task.taskId },
      checkInIndex: count,
      elapsedMs: now - task.startedAt,
      details: task,
    });
    this.#progress.set(task.taskId, { lastCheckInAt: now, count, startedAt: task.startedAt });
    if (policy) policy.nextDueAt = undefined;
  }
}

function eligible(task: DirectTaskState): boolean {
  return task.mode === 'background' && (task.status === 'running' || task.status === 'waiting_for_answer');
}

function validPolicy(policy: DirectBackgroundCheckInPolicy): boolean {
  return (
    (policy.enabled === undefined || typeof policy.enabled === 'boolean') &&
    (policy.intervalMs === undefined || (Number.isFinite(policy.intervalMs) && policy.intervalMs > 0)) &&
    (policy.nextDueInMs === undefined || (Number.isFinite(policy.nextDueInMs) && policy.nextDueInMs >= 0))
  );
}
