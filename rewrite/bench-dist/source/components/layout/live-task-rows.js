const liveTaskKey = (task) => {
    if (task.kind === 'shell') {
        if ('id' in task)
            return `shell:${task.id}`;
        return `shell:${task.jobId}`;
    }
    if ('id' in task)
        return `subagent:${task.id}`;
    return `subagent:${task.runId}`;
};
export const isLiveTaskRow = (value) => typeof value === 'object' &&
    value !== null &&
    'placement' in value &&
    'task' in value &&
    'key' in value &&
    (value.placement === 'foreground' || value.placement === 'background');
export const mergeLiveTaskRows = ({ foreground = [], background = [], }) => [
    ...foreground.map((task) => ({ key: liveTaskKey(task), placement: 'foreground', task })),
    ...background.map((task) => ({ key: liveTaskKey(task), placement: 'background', task })),
];
export const normalizeLiveTaskRows = (tasks) => {
    if (tasks.length === 0)
        return [];
    if (isLiveTaskRow(tasks[0]))
        return [...tasks];
    return mergeLiveTaskRows({ background: tasks });
};
//# sourceMappingURL=live-task-rows.js.map