import { BACKGROUND_SHELL_QUIET_AFTER_MS, BACKGROUND_SUBAGENT_QUIET_AFTER_MS, normalizeBackgroundTaskActivity, } from './background-task-liveness.js';
import { getCatalogModel } from '../../providers/model-catalog/catalog.js';
export { BACKGROUND_SUBAGENT_QUIET_AFTER_MS } from './background-task-liveness.js';
/**
 * UI-facing control surface for conversation-owned background work.
 *
 * Registries remain the authority for liveness and cancellation. This module
 * hides their different identifier and outcome conventions, and owns the
 * companion main-agent notification so callers cannot stop work without
 * informing the next planning step.
 */
export class BackgroundTaskControl {
    #client;
    #notifications;
    #onNotification;
    #onTaskChange;
    #now;
    constructor({ client, notifications, onNotification, onTaskChange, now = Date.now, }) {
        this.#client = client;
        this.#notifications = notifications;
        this.#onNotification = onNotification;
        this.#onTaskChange = onTaskChange;
        this.#now = now;
    }
    /** Lists live registry entries first, followed by retained terminal entries. */
    listDetails() {
        const subagents = this.#client.listBackgroundSubagentStatuses?.() ?? [];
        const shells = this.#client.listBackgroundShellJobs?.() ?? [];
        const details = [
            ...subagents.map((status) => this.#subagentDetails(status)).filter(isDefined),
            ...shells.map((job) => this.#shellDetails(job)),
        ];
        return details.sort((a, b) => Number(isTerminal(a)) - Number(isTerminal(b)));
    }
    getDetails(target) {
        if (target.kind === 'subagent') {
            const status = this.#client.getBackgroundSubagentStatus?.(target.id);
            return status ? this.#subagentDetails(status) : null;
        }
        const job = this.#client.getBackgroundShellJob?.(target.id);
        return job ? this.#shellDetails(job) : null;
    }
    requestStop(target) {
        const before = this.getDetails(target);
        if (!before)
            return { ok: false, code: this.#isAvailable(target) ? 'not_found' : 'unavailable' };
        if (target.kind === 'subagent') {
            const acknowledged = this.#client.requestBackgroundSubagentStop?.(target.id);
            if (!acknowledged)
                return { ok: false, code: 'unavailable' };
            if (!acknowledged.ok)
                return { ok: false, code: 'not_active' };
            const details = {
                ...before,
                status: 'cancelling',
                activity: normalizeBackgroundTaskActivity({
                    status: 'cancelling',
                    activityState: 'cancelling',
                    lastObservation: { kind: 'stop_requested', at: this.#now() },
                    now: this.#now(),
                    quietAfterMs: target.kind === 'subagent' ? BACKGROUND_SUBAGENT_QUIET_AFTER_MS : BACKGROUND_SHELL_QUIET_AFTER_MS,
                }),
            };
            this.#notifyStop(target, details);
            return { ok: true, details };
        }
        const stopped = this.#client.requestBackgroundShellStop?.(target.id);
        if (stopped === undefined)
            return { ok: false, code: 'unavailable' };
        if (!stopped)
            return { ok: false, code: 'not_active' };
        const details = {
            ...before,
            status: 'cancelling',
            activity: normalizeBackgroundTaskActivity({
                status: 'cancelling',
                activityState: 'cancelling',
                lastObservation: { kind: 'stop_requested', at: this.#now() },
                now: this.#now(),
                quietAfterMs: BACKGROUND_SHELL_QUIET_AFTER_MS,
            }),
        };
        this.#notifyStop(target, details);
        return { ok: true, details };
    }
    getForegroundTransferCandidate() {
        const candidate = this.#client.getForegroundShellTransferCandidate?.();
        return candidate ? this.#foregroundShellDetails(candidate) : null;
    }
    listForegroundTransferCandidates() {
        const shell = this.getForegroundTransferCandidate();
        const subagents = this.#client.listForegroundSubagentCandidates?.() ?? [];
        return [
            ...(shell ? [shell] : []),
            ...subagents.map((candidate) => ({ ...candidate, kind: 'subagent', status: 'running' })),
        ];
    }
    moveForegroundToBackground(target) {
        if (target.kind === 'subagent')
            return this.#moveForegroundSubagent(target.runId);
        const before = this.getForegroundTransferCandidate();
        if (!before || before.callId !== target.callId) {
            return { ok: false, code: this.#client.getForegroundShellTransferCandidate ? 'not_found' : 'unavailable' };
        }
        if (!this.#client.moveForegroundShellToBackground)
            return { ok: false, code: 'unavailable' };
        let adopted;
        try {
            adopted = this.#client.moveForegroundShellToBackground?.(target.callId);
        }
        catch (error) {
            if (error instanceof Error && error.name === 'BackgroundShellRegistryCapacityError') {
                return { ok: false, code: 'capacity' };
            }
            return { ok: false, code: 'not_active' };
        }
        if (!adopted)
            return { ok: false, code: 'not_active' };
        const job = this.#client.getBackgroundShellJob?.(adopted.jobId);
        if (!job)
            return { ok: false, code: 'not_active' };
        const details = this.#shellDetails(job);
        const queued = this.#notifications.enqueueUserControl({
            action: 'background',
            target: { kind: 'shell', id: adopted.jobId },
            details: { kind: 'shell', id: adopted.jobId, command: details.command },
        });
        if (queued)
            this.#onNotification?.();
        this.#onTaskChange?.();
        return { ok: true, details };
    }
    #moveForegroundSubagent(runId) {
        const candidate = (this.#client.listForegroundSubagentCandidates?.() ?? []).find((item) => item.runId === runId);
        if (!candidate) {
            return { ok: false, code: this.#client.listForegroundSubagentCandidates ? 'not_found' : 'unavailable' };
        }
        if (!this.#client.moveForegroundSubagent)
            return { ok: false, code: 'unavailable' };
        let adopted;
        try {
            adopted = this.#client.moveForegroundSubagent?.(runId);
        }
        catch (error) {
            if (error instanceof Error && error.name === 'SubagentRegistryError')
                return { ok: false, code: 'capacity' };
            return { ok: false, code: 'not_active' };
        }
        if (!adopted)
            return { ok: false, code: 'not_active' };
        const details = this.getDetails({ kind: 'subagent', id: adopted.runId });
        if (!details)
            return { ok: false, code: 'not_active' };
        const queued = this.#notifications.enqueueUserControl({
            action: 'background',
            target: { kind: 'subagent', id: adopted.runId },
            details: { kind: 'subagent', id: adopted.runId, role: adopted.role, task: adopted.task },
        });
        if (queued)
            this.#onNotification?.();
        this.#onTaskChange?.();
        return { ok: true, details };
    }
    #isAvailable(target) {
        return target.kind === 'subagent'
            ? typeof this.#client.getBackgroundSubagentStatus === 'function'
            : typeof this.#client.getBackgroundShellJob === 'function';
    }
    #notifyStop(target, details) {
        const queued = this.#notifications.enqueueUserControl({ action: 'stop', target, details });
        if (queued)
            this.#onNotification?.();
        // Cancellation is asynchronous. Expose the cancelling transition immediately
        // while the registry retains ownership until its ordinary terminal event.
        this.#onTaskChange?.();
    }
    #subagentDetails(status) {
        if (status.status === 'not_found')
            return null;
        const { runId, activityState, waitingReason, lastActivityAt, lastObservation, model, ...details } = status;
        const notificationTask = this.#notifications.getTask?.(runId);
        const subagentTask = notificationTask && notificationTask.kind !== 'shell' ? notificationTask : undefined;
        return {
            kind: 'subagent',
            id: runId,
            ...details,
            status: status.status,
            ...(subagentTask?.lastTool ? { lastTool: subagentTask.lastTool } : {}),
            ...(subagentTask?.recentTools ? { recentTools: subagentTask.recentTools } : {}),
            activity: normalizeBackgroundTaskActivity({
                status: status.status,
                activityState: status.status === 'awaiting_approval' || status.status === 'waiting_for_answer' ? 'waiting' : activityState,
                waitingReason: status.status === 'awaiting_approval'
                    ? 'approval'
                    : status.status === 'waiting_for_answer'
                        ? 'answer'
                        : waitingReason,
                ...(lastObservation === undefined
                    ? { lastActivityAt: lastActivityAt ?? status.startedAt }
                    : { lastObservation }),
                now: this.#now(),
                quietAfterMs: BACKGROUND_SUBAGENT_QUIET_AFTER_MS,
            }),
            ...(model === undefined
                ? {}
                : {
                    model: {
                        ...model,
                        ...(getCatalogModel(model.provider, model.id)?.contextWindow === undefined
                            ? {}
                            : { contextWindow: getCatalogModel(model.provider, model.id)?.contextWindow }),
                    },
                }),
        };
    }
    #shellDetails(job) {
        const { id, result, lastActivityAt, lastObservation, ...details } = job;
        const output = result && typeof result === 'object' && 'output' in result && typeof result.output === 'string'
            ? result.output
            : undefined;
        return {
            kind: 'shell',
            id,
            ...details,
            activity: normalizeBackgroundTaskActivity({
                status: job.status,
                ...(lastObservation === undefined ? { lastActivityAt: lastActivityAt ?? job.startedAt } : { lastObservation }),
                now: this.#now(),
                quietAfterMs: BACKGROUND_SHELL_QUIET_AFTER_MS,
            }),
            ...(output === undefined ? {} : { output }),
        };
    }
    #foregroundShellDetails(candidate) {
        return { kind: 'shell', ...candidate };
    }
}
function isDefined(value) {
    return value !== null;
}
function isTerminal(details) {
    return (details.status !== 'running' &&
        details.status !== 'awaiting_approval' &&
        details.status !== 'waiting_for_answer' &&
        details.status !== 'cancelling');
}
//# sourceMappingURL=background-task-control.js.map