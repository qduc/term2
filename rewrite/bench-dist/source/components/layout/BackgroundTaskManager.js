import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { sanitizeBackgroundTaskToolLabel } from '../../services/background-task-activity.js';
import { formatBackgroundTaskElapsed } from './BackgroundTasksPanel.js';
import { terminalTextWidth, truncateTerminalText } from './terminal-text-budget.js';
import { MenuFooter } from '../common/MenuContainer.js';
import { MESSAGE_HORIZONTAL_PADDING } from '../message/MessageList.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const taskTarget = (details) => ({
    kind: details.kind,
    id: details.id,
});
const backgroundKey = (details) => `${details.kind}:${details.id}`;
const foregroundKey = (details) => details.kind === 'shell' ? `foreground-shell:${details.callId}` : `foreground-subagent:${details.runId}`;
const taskLabel = (details) => {
    if (details.kind === 'shell')
        return details.command;
    return details.name ?? `${details.role}: ${details.taskPreview}`;
};
const foregroundTaskLabel = (candidate) => candidate.kind === 'shell' ? candidate.command : candidate.task;
const compactLabel = (value, columns, prefix, suffix) => {
    const firstLine = value.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
    const collapsed = firstLine.replace(/\s+/g, ' ').trim();
    // The classic frame has two borders and horizontal padding on both sides.
    // Reserve the actual row decorations so the status stays with its identity.
    const frameWidth = 4;
    const overhead = frameWidth + terminalTextWidth(prefix) + terminalTextWidth(suffix);
    const labelBudget = Math.max(1, Math.min(72, columns - overhead));
    return truncateTerminalText(collapsed, labelBudget);
};
const isLiveTask = (details) => details.status === 'running' ||
    details.status === 'awaiting_approval' ||
    details.status === 'waiting_for_answer' ||
    details.status === 'cancelling';
const isActive = (details) => details.status === 'running' || details.status === 'waiting_for_answer' || details.status === 'awaiting_approval';
const statusText = (details) => {
    const status = details.status;
    if (status === 'failed')
        return 'failed · terminal';
    if (status === 'completed')
        return 'completed · terminal';
    if (status === 'timed_out')
        return 'timed out · terminal';
    if (status === 'cancelled')
        return 'cancelled · terminal';
    if (status === 'interrupted')
        return 'budget exhausted · terminal';
    const activity = details.activity;
    if (!activity)
        return status.replaceAll('_', ' ');
    if (activity.phase === 'waiting')
        return `awaiting ${activity.reason ?? 'provider'} response${activity.liveness.state === 'quiet' ? ' · quiet' : ''}`;
    if (activity.phase === 'cancelling')
        return 'cancelling';
    if (activity.phase === 'settled')
        return `${status.replaceAll('_', ' ')} · terminal`;
    return 'active';
};
const observationText = (details) => {
    const observation = details.activity?.lastObservation;
    if (!observation)
        return undefined;
    switch (observation.kind) {
        case 'request_dispatched':
            return 'Request handed to model runtime';
        case 'response_started':
            return 'Response started';
        case 'text_received':
            return 'Text received';
        case 'tool_input_received':
            return `Tool input received: ${observation.toolName} (${observation.argumentCharCount} chars)`;
        case 'tool_started':
            return `Tool started: ${observation.toolName}`;
        case 'tool_completed':
            return observation.toolName ? `Tool completed: ${observation.toolName}` : 'Tool completed';
        case 'retrying':
            return `Retrying ${observation.attempt} of ${observation.maxRetries}`;
        case 'approval_requested':
            return 'Approval requested';
        case 'question_asked':
            return 'Question asked';
        case 'shell_started':
            return 'Shell started';
        case 'shell_output_received':
            return 'Shell output received';
        case 'stop_requested':
            return 'Stop requested';
        case 'settled':
            return 'Task settled';
    }
};
const formatContext = (promptTokens, contextWindow) => {
    const tokens = promptTokens >= 1000 ? `${(promptTokens / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(promptTokens);
    if (!contextWindow)
        return tokens;
    const max = contextWindow >= 1000 ? `${(contextWindow / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(contextWindow);
    return `${tokens} / ${max} (${((promptTokens / contextWindow) * 100).toFixed(1)}%)`;
};
export const BACKGROUND_TASK_MANAGER_TOOLS_ROW_LIMIT = 80;
const BACKGROUND_TASK_MANAGER_TOOL_NAME_LIMIT = 24;
const formatToolCounts = (counts) => {
    const entries = Object.entries(counts).map(([name, count]) => ({
        name: truncateTerminalText(sanitizeBackgroundTaskToolLabel(name) || 'tool', BACKGROUND_TASK_MANAGER_TOOL_NAME_LIMIT),
        count: ` ×${count}`,
    }));
    let rendered = '';
    let renderedCount = 0;
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const separator = rendered ? ', ' : '';
        const remaining = entries.length - index - 1;
        const omitted = remaining > 0 ? `, … +${remaining} more` : '';
        const next = `${rendered}${separator}${entry.name}${entry.count}`;
        if (terminalTextWidth(next) + terminalTextWidth(omitted) > BACKGROUND_TASK_MANAGER_TOOLS_ROW_LIMIT)
            break;
        rendered = next;
        renderedCount += 1;
    }
    const omittedCount = entries.length - renderedCount;
    if (!rendered)
        return `… +${omittedCount} more`;
    return omittedCount > 0 ? `${rendered}, … +${omittedCount} more` : rendered;
};
const BackgroundTaskDetailsView = ({ details }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2 },
        React.createElement(Text, { color: theme.accentAlt },
            "ID: ",
            details.id),
        React.createElement(Text, null,
            "State: ",
            statusText(details)),
        details.activity && (React.createElement(Text, null,
            "Last observed: ",
            formatBackgroundTaskElapsed(details.activity.liveness.ageMs),
            " ago",
            details.activity.liveness.state === 'quiet' ? ' (quiet)' : '')),
        observationText(details) && React.createElement(Text, null,
            "Last activity: ",
            observationText(details)),
        details.kind === 'shell' ? (React.createElement(React.Fragment, null,
            React.createElement(Text, { wrap: "wrap" },
                "Command: ",
                details.command),
            details.output && React.createElement(Text, { wrap: "wrap" },
                "Output: ",
                details.output),
            details.error && React.createElement(Text, { color: theme.dangerSoft },
                "Error: ",
                details.error))) : (React.createElement(React.Fragment, null,
            React.createElement(Text, null,
                "Role: ",
                details.role),
            details.name && React.createElement(Text, null,
                "Name: ",
                details.name),
            React.createElement(Text, { wrap: "wrap" },
                "Task: ",
                details.task),
            React.createElement(Text, null,
                "Started: ",
                formatBackgroundTaskElapsed(details.elapsedMs),
                " ago"),
            details.model && React.createElement(Text, null,
                "Model: ",
                details.model.id),
            details.model && React.createElement(Text, null,
                "Provider: ",
                details.model.provider),
            details.latestUsage?.prompt_tokens !== undefined && (React.createElement(Text, null,
                "Context: ",
                formatContext(details.latestUsage.prompt_tokens, details.model?.contextWindow))),
            details.activity?.lastObservation.kind === 'retrying' && (React.createElement(Text, null,
                "Retries: ",
                details.activity.lastObservation.attempt,
                " of ",
                details.activity.lastObservation.maxRetries)),
            details.lastToolName && React.createElement(Text, null,
                "Last tool: ",
                details.lastToolName),
            Object.keys(details.toolCounts).length > 0 && React.createElement(Text, null,
                "Tools: ",
                formatToolCounts(details.toolCounts)),
            details.currentText && React.createElement(Text, { wrap: "wrap" },
                "Current: ",
                details.currentText)))));
};
/** Keyboard-owned modal for retained background task inspection and per-item stop. */
const BackgroundTaskManager = ({ enabled = true, open, listDetails, getDetails, requestStop, getForegroundTransferCandidate, listForegroundTransferCandidates, moveForegroundToBackground, onOpenChange, }) => {
    const theme = useTheme();
    const { stdout } = useStdout();
    // The manager is rendered inside an outer Box with this horizontal padding.
    const labelColumns = Math.max(1, (stdout.columns || 80) - MESSAGE_HORIZONTAL_PADDING * 2);
    const { MenuFrame } = useSkin();
    const [selectedKey, setSelectedKey] = useState(null);
    const [selectedOrdinal, setSelectedOrdinal] = useState(0);
    const [detailsVisible, setDetailsVisible] = useState(false);
    const [stopArmedKey, setStopArmedKey] = useState(null);
    const [backgroundArmedKey, setBackgroundArmedKey] = useState(null);
    const [feedback, setFeedback] = useState(null);
    const [hiddenForeground, setHiddenForeground] = useState(new Set());
    const legacyForeground = getForegroundTransferCandidate?.() ?? null;
    const foregroundSource = listForegroundTransferCandidates?.() ?? (legacyForeground ? [legacyForeground] : []);
    const foreground = foregroundSource.filter((candidate) => !hiddenForeground.has(foregroundKey(candidate)));
    const tasks = listDetails().filter(isLiveTask);
    const rows = useMemo(() => [
        ...foreground.map((task) => ({ key: foregroundKey(task), kind: 'foreground', task })),
        ...tasks.map((task) => ({ key: backgroundKey(task), kind: 'background', task })),
    ], [foreground, tasks]);
    const keyedIndex = selectedKey === null ? -1 : rows.findIndex((row) => row.key === selectedKey);
    const selectedIndex = keyedIndex >= 0 ? keyedIndex : Math.min(selectedOrdinal, Math.max(0, rows.length - 1));
    const selectedRow = rows[selectedIndex];
    const close = useCallback(() => {
        setDetailsVisible(false);
        setStopArmedKey(null);
        setBackgroundArmedKey(null);
        setFeedback(null);
        onOpenChange?.(false);
    }, [onOpenChange]);
    const openManager = useCallback(() => {
        const next = listDetails().filter(isLiveTask);
        const legacy = getForegroundTransferCandidate?.() ?? null;
        const nextForeground = listForegroundTransferCandidates?.() ?? (legacy ? [legacy] : []);
        if (next.length === 0 && nextForeground.length === 0)
            return;
        setSelectedKey(nextForeground[0] ? foregroundKey(nextForeground[0]) : backgroundKey(next[0]));
        setSelectedOrdinal(0);
        setDetailsVisible(false);
        setStopArmedKey(null);
        setBackgroundArmedKey(null);
        setHiddenForeground(new Set());
        setFeedback(null);
        onOpenChange?.(true);
    }, [getForegroundTransferCandidate, listDetails, listForegroundTransferCandidates, onOpenChange]);
    useEffect(() => {
        if (open && !enabled)
            close();
    }, [close, enabled, open]);
    useInput((input, key) => {
        // Some terminals report the raw BEL control byte (\x07) for Ctrl+G
        // instead of setting key.ctrl, mirroring the Ctrl+O/Ctrl+T fallback in
        // useAppKeyboardShortcuts.
        const isCtrlG = (key.ctrl && input.toLowerCase() === 'g') || input === '\x07';
        if (!open) {
            if (isCtrlG)
                openManager();
            return;
        }
        if (key.escape || isCtrlG) {
            close();
            return;
        }
        if (key.upArrow || key.downArrow) {
            if (rows.length === 0)
                return;
            const nextIndex = key.upArrow
                ? (selectedIndex - 1 + rows.length) % rows.length
                : (selectedIndex + 1) % rows.length;
            setSelectedKey(rows[nextIndex].key);
            setSelectedOrdinal(nextIndex);
            setDetailsVisible(false);
            setStopArmedKey(null);
            setBackgroundArmedKey(null);
            setFeedback(null);
            return;
        }
        const selectedForeground = selectedRow?.kind === 'foreground' ? selectedRow.task : null;
        const selected = selectedRow?.kind === 'background' ? selectedRow.task : undefined;
        if (selectedForeground) {
            if (input.toLowerCase() === 'b' && moveForegroundToBackground) {
                setBackgroundArmedKey(selectedRow.key);
                setFeedback(null);
                return;
            }
            if (!key.return)
                return;
            if (backgroundArmedKey !== selectedRow.key) {
                setDetailsVisible(true);
                return;
            }
            const target = selectedForeground.kind === 'shell'
                ? { kind: 'shell', callId: selectedForeground.callId }
                : { kind: 'subagent', runId: selectedForeground.runId };
            const result = moveForegroundToBackground?.(target);
            setBackgroundArmedKey(null);
            if (result?.ok) {
                setHiddenForeground((current) => new Set(current).add(selectedRow.key));
                setSelectedKey(backgroundKey(result.details));
                setSelectedOrdinal(0);
                setDetailsVisible(true);
                setFeedback('Moved to background');
            }
            else {
                setFeedback(result?.code === 'capacity' ? 'Background task limit reached' : 'Task is no longer transferable');
            }
            return;
        }
        if (!selected)
            return;
        if (input.toLowerCase() === 'x' && isActive(selected)) {
            setStopArmedKey(selectedRow.key);
            setFeedback(null);
            return;
        }
        if (!key.return)
            return;
        const target = taskTarget(selected);
        if (stopArmedKey === selectedRow.key) {
            const result = requestStop(target);
            setStopArmedKey(null);
            if (result.ok) {
                setDetailsVisible(true);
                setFeedback('Stop requested');
            }
            else {
                setFeedback(result.code === 'not_active' ? 'Task is no longer active' : 'Task is no longer available');
            }
            return;
        }
        const latest = getDetails(target);
        if (!latest) {
            setFeedback('Task is no longer available');
            return;
        }
        setDetailsVisible(true);
        setFeedback(null);
    }, { isActive: enabled });
    if (!open)
        return null;
    const selectedForeground = selectedRow?.kind === 'foreground' ? selectedRow.task : null;
    const selected = selectedRow?.kind === 'background' ? selectedRow.task : undefined;
    return (React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
        React.createElement(MenuFrame, { title: "Manage background tasks", borderColor: theme.accentAlt, hasItems: false, footerPlacement: "outside" },
            foreground.map((candidate, index) => (React.createElement(Text, { key: `${candidate.kind}:${candidate.kind === 'shell' ? candidate.callId : candidate.runId}`, color: index === selectedIndex ? theme.text : theme.textSubtle },
                `${index === selectedIndex ? '❯' : ' '} [${candidate.kind === 'shell' ? 'Shell' : candidate.role} · foreground] `,
                compactLabel(foregroundTaskLabel(candidate), labelColumns, `${index === selectedIndex ? '❯' : ' '} [${candidate.kind === 'shell' ? 'Shell' : candidate.role} · foreground] `, ' · running'),
                "\u00B7 running"))),
            tasks.map((task, index) => {
                const displayIndex = index + foreground.length;
                return (React.createElement(Text, { key: `${task.kind}:${task.id}`, color: displayIndex === selectedIndex ? theme.text : theme.textSubtle },
                    `${displayIndex === selectedIndex ? '❯' : ' '} [${task.kind === 'shell' ? 'Shell' : task.role}] `,
                    compactLabel(taskLabel(task), labelColumns, `${displayIndex === selectedIndex ? '❯' : ' '} [${task.kind === 'shell' ? 'Shell' : task.role}] `, ` · ${statusText(task)}`),
                    "\u00B7 ",
                    statusText(task)));
            }),
            detailsVisible && selectedForeground && (React.createElement(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2 },
                React.createElement(Text, { color: theme.accentAlt },
                    selectedForeground.kind === 'shell' ? 'Call ID' : 'Run ID',
                    ":",
                    ' ',
                    selectedForeground.kind === 'shell' ? selectedForeground.callId : selectedForeground.runId),
                React.createElement(Text, null, "Status: running in foreground"),
                React.createElement(Text, { wrap: "wrap" },
                    selectedForeground.kind === 'shell' ? 'Command' : 'Task',
                    ":",
                    ' ',
                    selectedForeground.kind === 'shell' ? selectedForeground.command : selectedForeground.task))),
            detailsVisible && selected && React.createElement(BackgroundTaskDetailsView, { details: selected }),
            stopArmedKey === selectedRow?.key && (React.createElement(Text, { color: theme.warning }, "Press Enter to force stop this task, or Esc to close.")),
            backgroundArmedKey === selectedRow?.key && (React.createElement(Text, { color: theme.warning },
                "Press Enter to put this ",
                selectedForeground?.kind === 'subagent' ? 'subagent' : 'shell',
                " in the background, or Esc to close.")),
            feedback && (React.createElement(Text, { color: feedback === 'Stop requested' || feedback === 'Moved to background' ? theme.warning : theme.dangerSoft }, feedback)),
            React.createElement(MenuFooter, { hints: [
                    ['↑↓', 'navigate'],
                    ['⏎', 'details'],
                    ...(selectedForeground ? [['b', 'background']] : []),
                    ...(selected && isActive(selected) ? [['x', 'force stop']] : []),
                    ['Esc', 'close'],
                ] }))));
};
export default BackgroundTaskManager;
//# sourceMappingURL=BackgroundTaskManager.js.map