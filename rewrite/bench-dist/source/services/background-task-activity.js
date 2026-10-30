export const BACKGROUND_SUBAGENT_QUIET_AFTER_MS = 30_000;
export const BACKGROUND_SHELL_QUIET_AFTER_MS = 10_000;
export const BACKGROUND_TASK_TOOL_LABEL_LIMIT = 80;
/** Bounds provider-derived labels before they enter retained presentation state. */
export const sanitizeBackgroundTaskToolLabel = (value) => {
    const normalized = value
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized.length > BACKGROUND_TASK_TOOL_LABEL_LIMIT
        ? `${normalized.slice(0, BACKGROUND_TASK_TOOL_LABEL_LIMIT - 1)}…`
        : normalized;
};
export const assessBackgroundTaskLiveness = ({ lastObservedAt, now, quietAfterMs, }) => {
    const ageMs = Math.max(0, now - lastObservedAt);
    return { state: ageMs >= quietAfterMs ? 'quiet' : 'recent', lastObservedAt, ageMs };
};
/** Compact, bounded wording shared by model-facing background work surfaces. */
export const formatBackgroundTaskLiveness = (activity) => {
    const phase = activity.phase === 'waiting' && activity.reason ? `waiting (${activity.reason})` : activity.phase;
    return `${phase}, ${activity.liveness.state}; last observed ${formatObservationAge(activity.liveness.ageMs)} ago`;
};
const formatObservationAge = (ageMs) => {
    const totalSeconds = Math.floor(Math.max(0, ageMs) / 1_000);
    if (totalSeconds < 60)
        return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (totalMinutes < 60)
        return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};
export const isTerminalStatus = (status) => status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
export const normalizeBackgroundTaskActivity = ({ status, activityState = 'active', waitingReason, lastObservation, lastActivityAt, now, quietAfterMs, }) => {
    const at = lastObservation?.at ?? lastActivityAt ?? now;
    const observation = lastObservation ?? { kind: isTerminalStatus(status) ? 'settled' : 'request_dispatched', at };
    const phase = isTerminalStatus(status)
        ? 'settled'
        : status === 'cancelling' || activityState === 'cancelling'
            ? 'cancelling'
            : activityState;
    return {
        phase,
        ...(phase === 'waiting' && waitingReason !== undefined ? { reason: waitingReason } : {}),
        lastObservation: observation,
        liveness: assessBackgroundTaskLiveness({ lastObservedAt: observation.at, now, quietAfterMs }),
    };
};
//# sourceMappingURL=background-task-activity.js.map