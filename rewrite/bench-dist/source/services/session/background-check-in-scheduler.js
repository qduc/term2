import { truncatePreview } from '../subagents/utils.js';
import { BACKGROUND_SHELL_QUIET_AFTER_MS, BACKGROUND_SUBAGENT_QUIET_AFTER_MS, normalizeBackgroundTaskActivity, } from '../background-task-activity.js';
const DEFAULT_TICK_MS = 30_000;
function checkInKey(target) {
    return `${target.kind}:${target.id}`;
}
function taskTarget(task) {
    return task.kind === 'shell' ? { kind: 'shell', id: task.jobId } : { kind: 'subagent', id: task.runId };
}
function taskDetails(task, deps, now) {
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
    const narrative = subagentStatus?.currentText?.trim() ||
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
                    activityState: subagentStatus.status === 'awaiting_approval' || subagentStatus.status === 'waiting_for_answer'
                        ? 'waiting'
                        : subagentStatus.activityState,
                    waitingReason: subagentStatus.status === 'awaiting_approval'
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
 * notification pipeline (see docs/plans/background-work/background-work-control/agent-checkin.md).
 *
 * Owns no execution state of its own — `getRunningTasks` reads the unified
 * task snapshot the notification store already maintains. Per-task due time,
 * policy overrides, and check-in count live only here, keyed by `${kind}:${id}`,
 * and are dropped the moment a task leaves the running snapshot (settled or evicted),
 * so a reused id after a task's lifecycle epoch bumps starts a fresh count.
 */
export class BackgroundCheckInScheduler {
    #getRunningTasks;
    #emit;
    #getSettings;
    #getSubagentStatus;
    #getShellJob;
    #getShellOutputTail;
    #now;
    #clearInterval;
    #timer;
    #progress = new Map();
    #policies = new Map();
    constructor(deps) {
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
    setTaskPolicy(target, policy) {
        const key = checkInKey(target);
        const existing = this.#policies.get(key) ?? {};
        if (policy.enabled !== undefined)
            existing.enabled = policy.enabled;
        if (policy.intervalMs !== undefined)
            existing.intervalMs = policy.intervalMs;
        if (policy.nextDueAt !== undefined)
            existing.nextDueAt = policy.nextDueAt;
        this.#policies.set(key, existing);
    }
    getTaskPolicy(target) {
        return this.#policies.get(checkInKey(target));
    }
    resolveTarget(targetNameOrId) {
        const trimmed = targetNameOrId.trim();
        if (!trimmed)
            return undefined;
        const running = this.#getRunningTasks().filter((t) => t.status === 'running');
        for (const task of running) {
            if (task.kind === 'shell' && task.jobId === trimmed) {
                return { kind: 'shell', id: task.jobId };
            }
            if (task.kind === 'subagent') {
                if (task.runId === trimmed || task.name === trimmed) {
                    return { kind: 'subagent', id: task.runId };
                }
            }
        }
        return undefined;
    }
    configureTaskCheckIn(targetNameOrId, options) {
        const target = this.resolveTarget(targetNameOrId);
        if (!target) {
            return { ok: false, error: `No active running background task found matching "${targetNameOrId}".` };
        }
        const nextDueAt = options.nextDueInMs !== undefined ? this.#now() + options.nextDueInMs : undefined;
        this.setTaskPolicy(target, {
            enabled: options.enabled,
            intervalMs: options.intervalMs,
            nextDueAt,
        });
        const changes = [];
        if (options.enabled !== undefined) {
            changes.push(options.enabled ? 'check-ins enabled' : 'check-ins muted');
        }
        if (options.intervalMs !== undefined) {
            changes.push(`interval set to ${Math.round(options.intervalMs / 1000)}s`);
        }
        if (options.nextDueInMs !== undefined) {
            changes.push(`next check-in in ${Math.round(options.nextDueInMs / 1000)}s`);
        }
        return {
            ok: true,
            message: `Check-in updated for ${target.kind} task "${target.id}": ${changes.join(', ')}.`,
        };
    }
    /** Exposed for tests; production callers rely on the internal timer. */
    tick() {
        const settings = this.#getSettings();
        const runningTasks = this.#getRunningTasks().filter((task) => task.status === 'running');
        const liveKeys = new Set(runningTasks.map((task) => checkInKey(taskTarget(task))));
        for (const key of this.#progress.keys()) {
            if (!liveKeys.has(key))
                this.#progress.delete(key);
        }
        for (const key of this.#policies.keys()) {
            if (!liveKeys.has(key))
                this.#policies.delete(key);
        }
        if (!settings.enabled)
            return;
        const now = this.#now();
        for (const task of runningTasks) {
            const target = taskTarget(task);
            const key = checkInKey(target);
            const policy = this.#policies.get(key);
            if (policy?.enabled === false)
                continue;
            const progress = this.#progress.get(key);
            const interval = policy?.intervalMs ?? settings.intervalMs;
            const dueAt = policy?.nextDueAt ?? (progress?.lastCheckInAt ?? task.startedAt) + interval;
            if (now < dueAt)
                continue;
            const checkInIndex = (progress?.checkInCount ?? 0) + 1;
            this.#progress.set(key, { lastCheckInAt: now, checkInCount: checkInIndex });
            if (policy?.nextDueAt !== undefined) {
                policy.nextDueAt = undefined;
            }
            this.#emit({
                type: 'background_check_in_due',
                target,
                checkInIndex,
                elapsedMs: now - task.startedAt,
                details: taskDetails(task, {
                    getSubagentStatus: this.#getSubagentStatus,
                    getShellJob: this.#getShellJob,
                    getShellOutputTail: this.#getShellOutputTail,
                }, now),
            });
        }
    }
    dispose() {
        if (this.#timer === undefined)
            return;
        this.#clearInterval(this.#timer);
        this.#timer = undefined;
    }
}
//# sourceMappingURL=background-check-in-scheduler.js.map