import { isTerminalSubagentResult } from './types.js';
import { formatToolCommand, parseToolArguments } from '../../utils/conversation/conversation-utils.js';
import { formatSubagentResult, truncatePreview } from './utils.js';
const DEFAULT_DELIVERED_ID_CAP = 256;
export const BACKGROUND_TASK_RECENT_RETENTION_MS = 5_000;
/** How many of a live run's newest tool calls the task panel shows. */
const BACKGROUND_SUBAGENT_RECENT_TOOL_LIMIT = 3;
/**
 * Pending notifications for background (async) subagent runs.
 *
 * Owns three invariants the callers must not have to re-derive:
 *  - Only async completions and async registry questions are notifiable.
 *    Foreground and nested activity has no async flag and never surfaces here.
 *  - A message is announced at most once, ever. Completion ids are stable per
 *    run while each question has its own id, allowing one live run to ask more
 *    than once over its lifetime without replaying either message.
 *  - Delivery is confirmed by the caller, not by reading. `drain()` hands over
 *    the pending batch and clears it; a caller whose delivery failed calls
 *    `retain()` to put the batch back at the front of the queue. Drain/retain
 *    was chosen over peek/commit because the common path (delivery succeeds) is
 *    then a single call, and because retained notifications are handed back as
 *    values rather than leaving the store holding provisional state. A message
 *    id stays deduped across both paths, so a retained notification is
 *    redelivered exactly once and a replayed event for it is still dropped.
 */
export class SubagentNotificationStore {
    #pending = new Map();
    #seen = new Set();
    /** Stop requests are session-scoped and their target count is registry-bounded. */
    #userControlMessageIds = new Set();
    #tasks = new Map();
    #settledTaskIds = new Set();
    #lifecycleEpochs = new Map();
    #now;
    #deliveredIdCap;
    #recentTaskRetentionMs;
    constructor(deps = {}) {
        this.#now = deps.now ?? Date.now;
        this.#deliveredIdCap = Math.max(1, deps.deliveredIdCap ?? DEFAULT_DELIVERED_ID_CAP);
        this.#recentTaskRetentionMs = Math.max(0, deps.recentTaskRetentionMs ?? BACKGROUND_TASK_RECENT_RETENTION_MS);
    }
    /**
     * Updates the read-only task projection for async starts, tool activity, and
     * completions. Only the newest tool calls of a live run are kept: the overview
     * answers "what is it doing now", not its full history.
     */
    recordLifecycle(event) {
        if (event.type === 'background_shell_started') {
            this.#purgeExpiredTasks();
            const existing = this.#tasks.get(event.jobId);
            if (existing?.kind === 'shell' && existing.status !== 'running')
                return false;
            if (existing?.kind === 'shell' && existing.status === 'running' && existing.command === event.command)
                return false;
            this.#tasks.set(event.jobId, {
                kind: 'shell',
                jobId: event.jobId,
                command: event.command,
                status: 'running',
                startedAt: existing?.startedAt ?? this.#now(),
            });
            return true;
        }
        if (event.type === 'background_shell_completed') {
            const existing = this.#tasks.get(event.jobId);
            if (existing?.kind === 'shell' && existing.status !== 'running')
                return false;
            const completedAt = this.#now();
            this.#tasks.set(event.jobId, {
                kind: 'shell',
                jobId: event.jobId,
                command: event.command,
                status: event.status,
                startedAt: existing?.kind === 'shell' ? existing.startedAt : completedAt,
                completedAt,
                ...(event.error ? { error: event.error } : {}),
            });
            return true;
        }
        if (event.type === 'subagent_tool_started' || event.type === 'subagent_command_message') {
            return this.#recordToolActivity(event);
        }
        if (event.type === 'subagent_usage_update') {
            const task = this.#tasks.get(event.agentId);
            if (!task || task.kind !== 'subagent' || task.status !== 'running')
                return false;
            this.#tasks.set(event.agentId, { ...task, usage: event.usage });
            return true;
        }
        if (event.type === 'subagent_started' && event.async === true) {
            // Retention is what separates replay from continuation here, so it has to
            // be current whether or not the UI has read a snapshot since.
            this.#purgeExpiredTasks();
            const existing = this.#tasks.get(event.agentId);
            // A terminal task still inside its retention window means this start is a
            // replay of the run that just finished, not a continuation of it.
            if (existing && existing.status !== 'running')
                return false;
            if (existing?.kind !== 'shell' &&
                existing?.status === 'running' &&
                existing.role === event.role &&
                existing.task === event.task) {
                return false;
            }
            // `continue_run_id` reuses a settled run id, so a start for one opens a
            // fresh lifecycle rather than replaying the old one.
            if (this.#settledTaskIds.delete(event.agentId)) {
                this.#bumpLifecycleEpoch(event.agentId);
            }
            this.#tasks.set(event.agentId, {
                kind: 'subagent',
                runId: event.agentId,
                ...(event.name !== undefined ? { name: event.name } : {}),
                role: event.role,
                task: event.task,
                status: 'running',
                startedAt: existing?.startedAt ?? this.#now(),
            });
            return true;
        }
        if (event.type !== 'subagent_completed' || event.async !== true)
            return false;
        const result = event.result;
        if (!result?.agentId || !isTerminalSubagentResult(result))
            return false;
        if (this.#settledTaskIds.has(result.agentId))
            return false;
        const existing = this.#tasks.get(result.agentId);
        if (existing && existing.status !== 'running')
            return false;
        const completedAt = this.#now();
        this.#tasks.set(result.agentId, {
            kind: 'subagent',
            runId: result.agentId,
            ...(existing?.kind !== 'shell' && existing?.name !== undefined
                ? { name: existing.name }
                : result.name !== undefined
                    ? { name: result.name }
                    : {}),
            role: existing && existing.kind !== 'shell' ? existing.role : result.role,
            task: existing && existing.kind !== 'shell' ? existing.task : '',
            status: result.status,
            startedAt: existing && existing.kind !== 'shell' ? existing.startedAt : completedAt,
            completedAt,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            ...(result.error ? { error: result.error } : {}),
        });
        this.#settledTaskIds.add(result.agentId);
        while (this.#settledTaskIds.size > this.#deliveredIdCap) {
            const oldest = this.#settledTaskIds.values().next().value;
            if (oldest === undefined)
                break;
            this.#settledTaskIds.delete(oldest);
        }
        return true;
    }
    /**
     * Projects the newest tool calls of a live run. Tool events carry no `async`
     * flag, so membership in the running task map is what scopes this to
     * background runs — foreground and nested activity never registers a task.
     */
    #recordToolActivity(event) {
        const task = this.#tasks.get(event.agentId);
        if (!task || task.kind !== 'subagent' || task.status !== 'running')
            return false;
        const lastTool = event.type === 'subagent_tool_started'
            ? {
                label: formatToolCommand(event.toolName, parseToolArguments(event.arguments)),
                state: 'running',
            }
            : {
                label: event.message?.command ?? '',
                state: event.message?.success === false ? 'failed' : 'success',
            };
        if (!lastTool.label)
            return false;
        const previous = task.recentTools ?? (task.lastTool ? [task.lastTool] : []);
        const newest = previous[previous.length - 1];
        if (newest?.label === lastTool.label && newest.state === lastTool.state)
            return false;
        const recentTools = [...previous, lastTool].slice(-BACKGROUND_SUBAGENT_RECENT_TOOL_LIMIT);
        this.#tasks.set(event.agentId, { ...task, lastTool, recentTools });
        return true;
    }
    getTaskSnapshot() {
        this.#purgeExpiredTasks();
        return [...this.#tasks.values()];
    }
    getTask(id) {
        this.#purgeExpiredTasks();
        return this.#tasks.get(id);
    }
    #purgeExpiredTasks() {
        const now = this.#now();
        for (const [runId, task] of this.#tasks) {
            if (task.completedAt !== undefined && now - task.completedAt >= this.#recentTaskRetentionMs) {
                this.#tasks.delete(runId);
            }
        }
    }
    /** Records one novel async completion or question, returning whether it woke the queue. */
    enqueue(event) {
        const notification = this.#notificationFor(event);
        if (!notification || this.#seen.has(notification.messageId))
            return false;
        this.#pending.set(notification.messageId, notification);
        this.#seen.add(notification.messageId);
        this.#evictOldestSeen();
        return true;
    }
    get pendingCount() {
        return this.#pending.size;
    }
    /** Hands over every pending notification in completion order and clears them. */
    drain() {
        const drained = [...this.#pending.values()];
        this.#pending.clear();
        // Handing the batch over is the point at which old ids become evictable:
        // nothing is owed a notification any more, only replay protection.
        this.#evictOldestSeen();
        return drained;
    }
    /** Returns undelivered notifications to the queue, ahead of anything newer. */
    retain(notifications) {
        if (notifications.length === 0)
            return;
        const newer = [...this.#pending.values()];
        this.#pending.clear();
        for (const notification of notifications) {
            this.#pending.set(notification.messageId, notification);
            this.#seen.add(notification.messageId);
        }
        for (const notification of newer)
            this.#pending.set(notification.messageId, notification);
    }
    enqueueUserControl(notification) {
        const lifecycleSuffix = notification.target.kind === 'subagent' ? `:${this.#lifecycleEpochs.get(notification.target.id) ?? 1}` : '';
        const messageId = `user_control:${notification.action}:${notification.target.kind}:${notification.target.id}${lifecycleSuffix}`;
        if (this.#userControlMessageIds.has(messageId))
            return false;
        this.#pending.set(messageId, { kind: 'user_control', ...notification, messageId, requestedAt: this.#now() });
        this.#userControlMessageIds.add(messageId);
        this.#seen.add(messageId);
        this.#evictOldestSeen();
        return true;
    }
    /**
     * Drops the oldest remembered ids once the cap is exceeded, skipping runs that
     * still owe a notification: correctness of an undelivered notification wins
     * over the memory bound, and the pending queue is itself bounded by the number
     * of runs the registry will retain. Forgetting an id only costs replay
     * protection for a run that was delivered long ago.
     */
    #evictOldestSeen() {
        if (this.#seen.size <= this.#deliveredIdCap)
            return;
        for (const messageId of this.#seen) {
            if (this.#seen.size <= this.#deliveredIdCap)
                return;
            if (this.#pending.has(messageId))
                continue;
            this.#seen.delete(messageId);
        }
    }
    /**
     * Completion ids are stable per lifecycle, not per run id. A run id that is
     * continued completes once per continuation, and each of those completions
     * owes the main agent its own notification; only a replay within one
     * lifecycle is a duplicate.
     */
    #completionMessageId(runId) {
        const epoch = this.#lifecycleEpochs.get(runId) ?? 1;
        return epoch > 1 ? `completion:${runId}#${epoch}` : `completion:${runId}`;
    }
    #bumpLifecycleEpoch(runId) {
        this.#lifecycleEpochs.set(runId, (this.#lifecycleEpochs.get(runId) ?? 1) + 1);
        while (this.#lifecycleEpochs.size > this.#deliveredIdCap) {
            const oldest = this.#lifecycleEpochs.keys().next().value;
            if (oldest === undefined || oldest === runId)
                break;
            this.#lifecycleEpochs.delete(oldest);
        }
    }
    #notificationFor(event) {
        if (event.type === 'background_shell_completed') {
            return {
                kind: 'shell_completion',
                messageId: `shell_completion:${event.jobId}`,
                jobId: event.jobId,
                command: event.command,
                status: event.status,
                output: event.output,
                ...(event.error ? { error: event.error } : {}),
                completedAt: this.#now(),
            };
        }
        if (event.type === 'background_shell_output') {
            return {
                kind: 'shell_output',
                messageId: `shell_output:${event.jobId}:${event.watchId}:${event.seq}`,
                jobId: event.jobId,
                command: event.command,
                watchId: event.watchId,
                seq: event.seq,
                matchedLines: event.matchedLines,
                ...(event.coalescedCount !== undefined ? { coalescedCount: event.coalescedCount } : {}),
                ...(event.seqRange !== undefined ? { seqRange: event.seqRange } : {}),
                ...(event.droppedBytes !== undefined ? { droppedBytes: event.droppedBytes } : {}),
                recordedAt: this.#now(),
            };
        }
        if (event.type === 'background_check_in_due') {
            return {
                kind: 'check_in',
                messageId: `check_in:${event.target.kind}:${event.target.id}:${event.checkInIndex}`,
                target: event.target,
                checkInIndex: event.checkInIndex,
                elapsedMs: event.elapsedMs,
                details: event.details,
                recordedAt: this.#now(),
            };
        }
        if (event.type === 'subagent_completed' && event.async === true) {
            const result = event.result;
            const runId = result?.agentId;
            if (!result || !runId || !isTerminalSubagentResult(result))
                return undefined;
            const task = this.#tasks.get(runId);
            return {
                kind: 'completion',
                messageId: this.#completionMessageId(runId),
                runId,
                ...(task?.kind !== 'shell' && task?.name !== undefined
                    ? { name: task.name }
                    : result.name !== undefined
                        ? { name: result.name }
                        : {}),
                role: result.role,
                status: result.status,
                preview: truncatePreview(result.finalText || result.error),
                formattedResult: formatSubagentResult(result),
                ...(result.error ? { error: result.error } : {}),
                completedAt: this.#now(),
            };
        }
        if (event.type === 'subagent_question' && event.async === true && event.messageId && event.runId) {
            return {
                kind: 'question',
                messageId: event.messageId,
                runId: event.runId,
                ...(event.name !== undefined ? { name: event.name } : {}),
                role: event.role,
                question: event.question,
                askedAt: this.#now(),
            };
        }
        if (event.type === 'subagent_run_budget') {
            // Soft is a wrap-up nudge for the child itself, delivered through its own
            // tool output. Escalating it would ask the parent to judge a run that has
            // not yet reached anything abnormal.
            if (event.event.type === 'budget_stage' && event.event.stage === 'soft')
                return undefined;
            const task = this.#tasks.get(event.agentId);
            const eventKey = event.event.type === 'budget_stage'
                ? `${event.event.type}:${event.event.stage}:${event.event.evidence.dimension}`
                : `${event.event.type}:${event.event.toolName}:${event.event.argumentsText}`;
            return {
                kind: 'budget',
                messageId: `budget:${event.agentId}:${eventKey}`,
                runId: event.agentId,
                ...(task?.kind !== 'shell' && task?.name !== undefined ? { name: task.name } : {}),
                role: event.role,
                event: event.event,
                recordedAt: this.#now(),
            };
        }
        return undefined;
    }
}
//# sourceMappingURL=subagent-notification-store.js.map