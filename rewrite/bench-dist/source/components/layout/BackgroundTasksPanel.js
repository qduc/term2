import React, { useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import { normalizeLiveTaskRows } from './live-task-rows.js';
import { BACKGROUND_TASKS_PANEL_GRACE_MS } from './background-task-clock.js';
import { terminalTextWidth, truncateTerminalText } from './terminal-text-budget.js';
import { TOOL_STATUS_GLYPH, useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
export const BACKGROUND_TASK_PANEL_NARROW_LABEL_LIMIT = 24;
export const BACKGROUND_TASK_PANEL_MEDIUM_LABEL_LIMIT = 36;
export const BACKGROUND_TASK_PANEL_WIDE_LABEL_LIMIT = 60;
const NAME_LIMIT = 24;
export const BACKGROUND_TASK_PANEL_MEDIUM_COLUMNS = 72;
export const BACKGROUND_TASK_PANEL_WIDE_COLUMNS = 104;
const BACKGROUND_TASK_PANEL_MIN_IDENTITY_COLUMNS = 6;
const truncate = truncateTerminalText;
// Multi-line prompts are common for subagent tasks; only the first line is a label.
const firstLine = (value) => value
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? '';
const formatRole = (role) => {
    if (!role)
        return 'Agent';
    return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
};
const isControlTask = (task) => 'id' in task;
const formatTaskLabel = (task) => {
    if (task.kind === 'shell') {
        return firstLine(task.command).replaceAll(/\s+/g, ' ');
    }
    const normalized = firstLine('taskPreview' in task ? task.taskPreview : task.task).replaceAll(/\s+/g, ' ');
    const label = normalized || `${formatRole(task.role)} background task`;
    return 'name' in task && task.name ? `${truncate(task.name, NAME_LIMIT)} ${label}` : label;
};
export const formatBackgroundTaskElapsed = (elapsedMs) => {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
};
/**
 * Compact clock for space-constrained panel rows (`45s`, `1:05`). Prose contexts
 * ("Started: 1m 05s ago" in the manager) keep `formatBackgroundTaskElapsed`, where
 * `1:05` would read as a time of day.
 */
export const formatBackgroundTaskClock = (elapsedMs) => {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
};
const formatPhase = (task, now) => {
    const activity = task.activity;
    if (activity?.phase === 'settled')
        return formatTerminalStatus(task);
    const base = !activity
        ? 'Running'
        : activity.phase === 'waiting'
            ? // Provider is the overwhelmingly common wait; only exceptional reasons
                // (approval, answer) cost the parenthetical, because they need the user.
                activity.reason && activity.reason !== 'provider'
                    ? `Waiting (${activity.reason})`
                    : 'Waiting'
            : activity.phase === 'cancelling'
                ? 'Cancelling'
                : 'Active';
    return `${base} · ${formatBackgroundTaskClock(now - task.startedAt)}`;
};
const formatFirstLine = ({ task, placement, columns, now, isWide, isNarrow, }) => {
    const controlTask = isControlTask(task) ? task : undefined;
    const badge = `[${task.kind === 'shell' ? 'Shell' : formatRole(task.role)}${placement === 'foreground' ? ' ↑' : ''}]`;
    const rawPhase = isTerminal(task)
        ? formatTerminalStatus(task)
        : controlTask
            ? formatPhase(controlTask, now)
            : formatLiveStatus(task, now);
    const fixedColumns = 2 + terminalTextWidth(badge) + 1 + 3;
    const phase = truncate(rawPhase, Math.max(1, columns - fixedColumns - BACKGROUND_TASK_PANEL_MIN_IDENTITY_COLUMNS));
    // "• " + badge + " " + identity + " · " + phase. Reserve every
    // mandatory cell except identity before allocating the task label.
    const mandatoryColumns = fixedColumns + terminalTextWidth(phase);
    const physicalBudget = Math.max(1, columns - mandatoryColumns);
    const classBudget = isNarrow
        ? BACKGROUND_TASK_PANEL_NARROW_LABEL_LIMIT
        : isWide
            ? BACKGROUND_TASK_PANEL_WIDE_LABEL_LIMIT
            : BACKGROUND_TASK_PANEL_MEDIUM_LABEL_LIMIT;
    return { badge, identity: truncate(formatTaskLabel(task), Math.min(physicalBudget, classBudget)), phase };
};
// Terminal rows linger only for the panel grace period, so the "recently"
// qualifier is carried by the row's imminent disappearance, not its wording.
// Status glyphs reuse the shared TOOL_STATUS_GLYPH vocabulary from the tool lines.
const formatTerminalStatus = (task) => {
    switch (task.status) {
        case 'completed':
            return '✓ Done';
        case 'failed': {
            const error = 'error' in task ? task.error : undefined;
            return error ? `✗ Failed (${error})` : '✗ Failed';
        }
        case 'cancelled':
            return 'Cancelled';
        case 'timed_out':
            return 'Timed out';
        case 'interrupted':
            return '✗ Interrupted (budget)';
        default:
            return 'Running';
    }
};
const isTerminal = (task) => task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'timed_out' ||
    task.status === 'cancelled' ||
    task.status === 'interrupted';
const formatLiveStatus = (task, now) => {
    const startedAt = 'startedAt' in task && typeof task.startedAt === 'number' ? task.startedAt : now;
    if (!isControlTask(task) || !task.activity) {
        return `Running · ${formatBackgroundTaskClock(now - startedAt)}`;
    }
    return formatPhase(task, now);
};
const latestTool = (task) => {
    if (task.kind === 'shell' || isTerminal(task))
        return undefined;
    if ('recentTools' in task && task.recentTools?.length)
        return task.recentTools.at(-1);
    return 'lastTool' in task ? task.lastTool : undefined;
};
const toolStatusKind = (state) => state === 'success' ? 'completed' : state;
const BackgroundTasksPanel = ({ tasks, now, columns: testColumns }) => {
    const theme = useTheme();
    const { stdout } = useStdout();
    const { TaskPanel, taskPanelGutter } = useSkin();
    const columns = (testColumns ?? stdout.columns ?? BACKGROUND_TASK_PANEL_MEDIUM_COLUMNS) - taskPanelGutter;
    const rows = normalizeLiveTaskRows(tasks);
    // The registry keeps terminal entries around indefinitely, so each settled row
    // lingers briefly — long enough to read its outcome — then drops off on its own.
    const settledAtRef = useRef(new Map());
    const settledAt = settledAtRef.current;
    const liveKeys = new Set(rows.map((row) => row.key));
    for (const key of settledAt.keys())
        if (!liveKeys.has(key))
            settledAt.delete(key);
    const visible = rows.filter((row) => {
        if (!isTerminal(row.task)) {
            settledAt.delete(row.key);
            return true;
        }
        const since = settledAt.get(row.key) ?? now;
        settledAt.set(row.key, since);
        return now - since < BACKGROUND_TASKS_PANEL_GRACE_MS;
    });
    if (visible.length === 0)
        return null;
    const activeCount = visible.filter((row) => !isTerminal(row.task)).length;
    return (React.createElement(TaskPanel, { header: `Tasks · ${activeCount} active · ^G manage` }, visible.map(({ key, placement, task }) => {
        const isNarrow = columns < BACKGROUND_TASK_PANEL_MEDIUM_COLUMNS;
        const isWide = columns >= BACKGROUND_TASK_PANEL_WIDE_COLUMNS;
        const formattedRow = formatFirstLine({ task, placement, columns, now, isWide, isNarrow });
        const tool = latestTool(task);
        const toolStatus = tool ? toolStatusKind(tool.state) : undefined;
        return (React.createElement(Box, { key: key, flexDirection: "column" },
            React.createElement(Text, null,
                React.createElement(Text, { color: theme.textSubtle }, "\u2022 "),
                React.createElement(Text, { color: theme.accentAlt }, formattedRow.badge),
                " ",
                React.createElement(Text, null, formattedRow.identity),
                " \u00B7",
                ' ',
                React.createElement(Text, null, formattedRow.phase)),
            tool && toolStatus ? (React.createElement(Text, { color: theme.textMuted },
                '  └ ',
                React.createElement(Text, { color: theme.toolStatus[toolStatus] }, TOOL_STATUS_GLYPH[toolStatus]),
                ' ',
                truncate(firstLine(tool.label).replaceAll(/\s+/g, ' '), Math.max(1, columns - 6)))) : null));
    })));
};
export default BackgroundTasksPanel;
//# sourceMappingURL=BackgroundTasksPanel.js.map