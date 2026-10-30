import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { generateDiff } from '../../utils/output/diff.js';
import { asDisplayArray, asDisplayString } from '../../utils/tool-args-display.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import { countDiffStats, extractErrorMessage, formatToolArgs, getFirstParagraph, getMatchCount, isStructuredToolError, isSearchLikeTool, parseCodeOutlineOutput, parseRunCodeTrace, truncateOutputLines, parseFindFilesOutput, parseSubagentOutput, stripRgErrorLines, } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
import DiffView from '../layout/DiffView.js';
import { useCommandVisibility } from './useCommandVisibility.js';
import ReadFileRenderer from './ReadFileRenderer.js';
import GrepRenderer from './GrepRenderer.js';
import WebSearchRenderer from './WebSearchRenderer.js';
import WebFetchRenderer from './WebFetchRenderer.js';
import CodeContextSearchRenderer from './CodeContextSearchRenderer.js';
import MemoryRenderer from './MemoryRenderer.js';
import RunCodeRenderer from './RunCodeRenderer.js';
const useRunningElapsedSeconds = (isRunning) => {
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    useEffect(() => {
        if (!isRunning) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- reset timer state when the command settles
            setElapsedSeconds(0);
            return;
        }
        const start = Date.now();
        const updateElapsed = () => {
            setElapsedSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
        };
        updateElapsed();
        const interval = setInterval(updateElapsed, 1000);
        return () => clearInterval(interval);
    }, [isRunning]);
    return elapsedSeconds;
};
const getConciseAskUserResponse = (output) => {
    if (!output)
        return 'No response';
    const lines = output.split('\n');
    const answers = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Answer: ')) {
            answers.push(trimmed.slice('Answer: '.length).trim());
        }
    }
    if (answers.length > 0) {
        return answers.join(', ');
    }
    return output;
};
const CommandMessage = ({ command, output: rawOutput, status, success, failureReason, toolName, toolArgs, isApprovalRejection, autoApprovedByLlm, hadApproval, displayMode = 'standard', textColor, isSubagent = false, awaitingDecision = false, }) => {
    const theme = useTheme();
    const { ToolFrame, ToolHeader, ToolSection } = useSkin();
    const { isVisible, isRunning } = useCommandVisibility(status);
    const isWaiting = awaitingDecision;
    const isQueued = status === 'pending' && !awaitingDecision;
    const isExecuting = isRunning && !awaitingDecision;
    const runningElapsedSeconds = useRunningElapsedSeconds(isExecuting);
    const runningElapsedLabel = isWaiting ? (React.createElement(Text, { color: theme.textSubtle }, " (waiting)")) : isQueued ? (React.createElement(Text, { color: theme.textSubtle }, " (queued)")) : isExecuting ? (React.createElement(Text, { color: theme.warning },
        " (",
        runningElapsedSeconds,
        "s)")) : null;
    const { output, runtime } = useMemo(() => {
        const isShell = !toolName || toolName === 'shell';
        if (isShell && rawOutput) {
            const match = rawOutput.match(/(?:^|\r?\n)Runtime:\s*(\d+ms)(?:\r?\n|$)/);
            if (match) {
                const cleaned = rawOutput.replace(/(?:^|\r?\n)Runtime:\s*\d+ms(?:\r?\n|$)/, '\n').trim();
                return {
                    output: cleaned,
                    runtime: match[1],
                };
            }
        }
        return { output: rawOutput || '', runtime: undefined };
    }, [toolName, rawOutput]);
    const diff = useMemo(() => {
        if (toolName !== TOOL_NAME_SEARCH_REPLACE || !toolArgs)
            return '';
        if (toolArgs.replacements) {
            return asDisplayArray(toolArgs.replacements)
                .map((rep) => generateDiff(rep?.search_content, rep?.replace_content))
                .join('\n');
        }
        return generateDiff(toolArgs.search_content, toolArgs.replace_content);
    }, [toolName, toolArgs]);
    const createFileDiffLines = useMemo(() => toolName === TOOL_NAME_CREATE_FILE && toolArgs
        ? asDisplayString(toolArgs.content)
            .split('\n')
            .map((line) => `+${line}`)
            .join('\n')
        : '', [toolName, toolArgs]);
    // Parse the denial reason from the JSON wrapper or output when isApprovalRejection is true.
    // Falls back to the standard approval-denial message when no output was provided.
    const denialReason = useMemo(() => {
        return extractErrorMessage(output) || 'Tool execution was not approved.';
    }, [output]);
    const formattedArgs = useMemo(() => {
        return toolArgs ? formatToolArgs(toolName, toolArgs, 'concise') : '';
    }, [toolName, toolArgs]);
    const isBackgroundSubagentLaunch = toolName === 'run_subagent' && toolArgs?.execution === 'background';
    // A script's nested calls only survive as text in its result, so the trace is
    // reconstructed at render time. It is absent while the call is still running.
    const runCodeTrace = useMemo(() => (toolName === 'run_code' ? parseRunCodeTrace(output) : null), [toolName, output]);
    const displayAction = useMemo(() => {
        const isShell = !toolName || toolName === 'shell';
        if (isShell) {
            return (React.createElement(React.Fragment, null,
                React.createElement(Text, { bold: true }, command),
                runtime && React.createElement(Text, { color: theme.textSubtle },
                    " (",
                    runtime,
                    ")")));
        }
        const argsText = toolName === 'background_subagent_notification' ||
            toolName === 'background_shell_notification' ||
            toolName === 'background_shell_output_notification' ||
            toolName === 'background_task_control_notification' ||
            toolName === 'background_check_in_notification' ||
            !formattedArgs
            ? ''
            : ` ${formattedArgs}`;
        const renderAction = (verb) => (React.createElement(React.Fragment, null,
            React.createElement(Text, { dimColor: true }, verb),
            React.createElement(Text, null, argsText)));
        // Notification headers are the entire concise view. Reuse the shell argument
        // preview instead of copying a potentially multiline script into that header.
        const shellNotificationLabel = (command) => {
            const label = asDisplayString(command) || 'job';
            return displayMode === 'concise'
                ? formatToolArgs('shell', { command: label.replace(/\s+/g, ' ') }, 'concise')
                : label;
        };
        switch (toolName) {
            case 'grep':
                return renderAction('Searched');
            case 'glob':
                return renderAction('Searched files');
            case 'read_file':
            case 'view_file':
                return renderAction('Read');
            case TOOL_NAME_APPLY_PATCH:
                return renderAction('Patched');
            case TOOL_NAME_SEARCH_REPLACE:
                return renderAction('Edited');
            case TOOL_NAME_CREATE_FILE:
                return renderAction('Created');
            case 'ask_mentor':
                return renderAction('Asked mentor');
            case 'ask_user':
                return renderAction('Asked user');
            case 'web_search':
                return renderAction('Web searched');
            case 'web_fetch':
                return renderAction('Web fetched');
            case 'read_code_outline':
                return renderAction('Read outline');
            case 'code_context_search':
                return renderAction('Searched context');
            case 'run_subagent':
                return renderAction(isBackgroundSubagentLaunch ? 'Delegated async' : 'Delegated');
            case 'run_subagent_async':
                return renderAction('Delegated async');
            case 'get_subagent_result':
                return renderAction('Got subagent result');
            case 'get_subagent_status':
                return renderAction('Checked subagent status');
            case 'send_message':
                return renderAction('Messaged subagent');
            case 'cancel_run':
                return renderAction('Cancelled subagent run');
            case 'ask_orchestrator':
                return renderAction('Asked orchestrator');
            case 'activate_skill':
                return renderAction('Activated skill');
            case 'run_agent_workflow':
                return renderAction('Ran agent workflow');
            case 'run_code':
                return renderAction('');
            case 'enter_worktree':
                return renderAction('Entered worktree');
            case 'exit_worktree':
                return renderAction('Left worktree');
            case 'background_subagent_notification': {
                const runs = Array.isArray(toolArgs?.runs) ? toolArgs.runs : [];
                if (runs.length === 1) {
                    const [{ name, role, status, error }] = runs;
                    const identity = name ? `${name} (${role ?? 'subagent'})` : role ?? 'subagent';
                    if (status === 'failed' || error) {
                        const reason = error ? `: ${error}` : '';
                        return renderAction(`Background ${identity} failed${reason}`);
                    }
                    return renderAction(`Background ${identity} ${status ?? 'finished'}`);
                }
                if (runs.length > 1) {
                    const failedRuns = runs.filter((run) => run.status === 'failed' || run.error);
                    if (failedRuns.length > 0) {
                        const reasons = failedRuns
                            .map((run) => run.error ? `${run.role ?? 'subagent'}: ${run.error}` : null)
                            .filter(Boolean);
                        if (reasons.length > 0) {
                            return renderAction(`Background subagents failed: ${reasons.join('; ')}`);
                        }
                    }
                    const roles = runs
                        .map((run) => run.role)
                        .filter(Boolean)
                        .join(', ');
                    return renderAction(`Background subagents finished: ${roles || runs.length}`);
                }
                return renderAction('Background subagent notification');
            }
            case 'background_shell_notification': {
                const jobs = Array.isArray(toolArgs?.jobs) ? toolArgs.jobs : [];
                if (jobs.length === 1) {
                    const [{ command, status, error }] = jobs;
                    const label = shellNotificationLabel(command);
                    if (status === 'failed' || status === 'timed_out' || error) {
                        const reason = error ? `: ${error}` : '';
                        return renderAction(`Background shell failed: ${label}${reason}`);
                    }
                    if (status === 'cancelled' || status === 'interrupted') {
                        return renderAction(`Background shell interrupted: ${label}`);
                    }
                    return renderAction(`Background shell completed: ${label}`);
                }
                return renderAction(`Background shell ${jobs.length || 'job'} notification`);
            }
            case 'background_shell_output_notification': {
                const firings = Array.isArray(toolArgs?.firings)
                    ? toolArgs.firings
                    : toolArgs && (toolArgs.jobId || toolArgs.watchId || toolArgs.command || toolArgs.matchedLines)
                        ? [toolArgs]
                        : [];
                if (firings.length === 1) {
                    const [{ command, matchedLines, coalescedCount }] = firings;
                    const label = shellNotificationLabel(command);
                    const lineCount = typeof coalescedCount === 'number'
                        ? coalescedCount
                        : typeof matchedLines === 'string'
                            ? matchedLines
                                ? matchedLines.split('\n').length
                                : 0
                            : Array.isArray(matchedLines)
                                ? matchedLines.length
                                : undefined;
                    const suffix = lineCount !== undefined && lineCount > 0 ? ` (${lineCount} line${lineCount === 1 ? '' : 's'})` : '';
                    return renderAction(`Background shell output: ${label}${suffix}`);
                }
                if (firings.length > 1) {
                    return renderAction(`Background shell output (${firings.length} jobs)`);
                }
                return renderAction('Background shell output');
            }
            case 'get_shell_job':
                return renderAction('Checked shell job');
            case 'cancel_shell_job':
                return renderAction('Cancelled shell job');
            case 'monitor_shell_job':
                return renderAction('Monitored shell output');
            case 'cancel_shell_monitor':
                return renderAction('Cancelled shell monitor');
            case 'background_task_control_notification': {
                const actions = Array.isArray(toolArgs?.actions) ? toolArgs.actions : [];
                if (actions.length === 1) {
                    const [{ action, target }] = actions;
                    if (action === 'stop' && target?.kind === 'subagent') {
                        return renderAction(`Stop requested for background subagent ${target.id ?? 'run'}`);
                    }
                    if (action === 'stop' && target?.kind === 'shell') {
                        return renderAction(`Stop requested for background shell ${target.id ?? 'job'}`);
                    }
                    if (action === 'background' && target?.kind === 'shell') {
                        return renderAction(`Moved shell ${target.id ?? 'job'} to background`);
                    }
                    if (action === 'background' && target?.kind === 'subagent') {
                        return renderAction(`Moved subagent ${target.id ?? 'run'} to background`);
                    }
                }
                return renderAction('Background task control updated');
            }
            case 'background_check_in_notification': {
                const checkIns = Array.isArray(toolArgs?.checkIns) ? toolArgs.checkIns : [];
                if (checkIns.length === 1) {
                    const [{ target, checkInIndex }] = checkIns;
                    const label = target?.kind === 'subagent'
                        ? `background subagent ${target.id ?? 'run'}`
                        : `background shell ${target?.id ?? 'job'}`;
                    const prefix = typeof checkInIndex === 'number' ? `Check-in #${checkInIndex}` : 'Check-in';
                    return renderAction(`${prefix} on ${label}`);
                }
                return renderAction(`Background check-in (${checkIns.length || 'task'})`);
            }
            case 'memory_list':
                return renderAction('Listed memories');
            case 'memory_get':
                return renderAction('Retrieved memory');
            case 'memory_search':
                return renderAction('Searched memories');
            case 'memory_retrieve':
                return renderAction('Retrieved relevant memories');
            case 'memory_create':
                return renderAction('Saved memory');
            case 'memory_update':
                return renderAction('Updated memory');
            case 'memory_delete':
                return renderAction('Deleted memory');
            case 'automatic_memory':
                return renderAction(success === false ? 'Automatic memory stopped' : 'Learned memory');
            case 'session_list':
                return renderAction('Listed prior sessions');
            case 'session_search':
                return renderAction('Searched prior sessions');
            case 'session_read':
                return renderAction('Read prior session');
            default:
                return renderAction(toolName || 'Ran tool');
        }
        // Depend on the whole `toolArgs`, not `toolArgs?.runs`: the React Compiler infers the
        // former and refuses to preserve the memo when the declared deps are narrower.
    }, [
        toolName,
        command,
        runtime,
        formattedArgs,
        toolArgs,
        isBackgroundSubagentLaunch,
        success,
        theme.textSubtle,
        displayMode,
    ]);
    // isApprovalRejection carries no `success` value of its own — it is a distinct
    // outcome from a normal failed run — so it is checked first and maps to the
    // same 'failed' glyph/color as success === false.
    const statusKind = isApprovalRejection || success === false || status === 'unknown'
        ? 'failed'
        : isWaiting || isQueued
            ? 'pending'
            : isRunning
                ? 'running'
                : 'completed';
    const renderStandardHeader = () => (React.createElement(ToolHeader, { toolName: toolName, status: statusKind, display: "standard", action: displayAction, meta: runningElapsedLabel }));
    const changeStats = useMemo(() => {
        const diffText = toolName === TOOL_NAME_APPLY_PATCH
            ? toolArgs?.diff
            : toolName === TOOL_NAME_SEARCH_REPLACE
                ? diff
                : toolName === TOOL_NAME_CREATE_FILE
                    ? createFileDiffLines
                    : '';
        if (!diffText) {
            return null;
        }
        const stats = countDiffStats(diffText);
        return stats.added === 0 && stats.removed === 0 ? null : stats;
    }, [createFileDiffLines, diff, toolArgs?.diff, toolName]);
    const changeStatsElement = changeStats ? (React.createElement(React.Fragment, null,
        ' ',
        "(",
        React.createElement(Text, { color: theme.textMuted },
            "+",
            changeStats.added),
        ' ',
        React.createElement(Text, { color: theme.danger },
            "-",
            changeStats.removed),
        ")")) : null;
    const matchCount = useMemo(() => {
        if (displayMode !== 'concise')
            return 0;
        if (!isSearchLikeTool(toolName, command))
            return 0;
        if (isRunning || isQueued || isApprovalRejection)
            return 0;
        return getMatchCount(toolName, command, output);
    }, [displayMode, toolName, command, isRunning, isQueued, isApprovalRejection, output]);
    const matchCountElement = matchCount > 0 ? (React.createElement(ToolSection, { variant: "indent" },
        React.createElement(Text, { color: theme.textSubtle },
            "(",
            matchCount,
            " match",
            matchCount !== 1 ? 'es' : '',
            ")"))) : null;
    // Concise mode draws the header alone, so a refused nested call would otherwise
    // vanish. Counts on a clean run would be noise, so only trouble is announced.
    const runCodeTroubleElement = displayMode === 'concise' && runCodeTrace && runCodeTrace.troubledCount > 0 ? (React.createElement(Text, { color: theme.danger },
        " (",
        runCodeTrace.troubledCount,
        " refused)")) : null;
    const autoApprovalLabel = autoApprovedByLlm ? React.createElement(Text, { color: theme.textSubtle }, "(Auto approved by LLM)") : null;
    if (!isVisible && !isSubagent) {
        return null;
    }
    // The special renderers are FCs invoked as plain functions, so this can type as ReactNode | Promise<ReactNode>.
    const renderContent = () => {
        if (displayMode === 'concise') {
            if (isSubagent) {
                const isFailed = status === 'failed' ||
                    status === 'aborted' ||
                    status === 'unknown' ||
                    isApprovalRejection ||
                    success === false ||
                    Boolean(failureReason);
                const subagentStatusKind = isFailed
                    ? 'failed'
                    : isWaiting || isQueued
                        ? 'pending'
                        : isRunning
                            ? 'running'
                            : 'completed';
                const actionText = isFailed ? command : displayAction;
                return (React.createElement(ToolHeader, { toolName: toolName, status: subagentStatusKind, display: "concise", nested: true, action: actionText, meta: runningElapsedLabel }));
            }
            if (isApprovalRejection) {
                return (React.createElement(Box, { flexDirection: "column" },
                    React.createElement(ToolHeader, { toolName: toolName, status: "rejected", display: "concise", action: displayAction, trailing: changeStatsElement, textColor: textColor }),
                    React.createElement(Text, { color: textColor || theme.textMuted },
                        " \u2192 DENIED: ",
                        denialReason)));
            }
            if (isRunning || isQueued || isWaiting) {
                const inFlightStatusKind = isWaiting || isQueued ? 'pending' : 'running';
                return (React.createElement(ToolHeader, { toolName: toolName, status: inFlightStatusKind, display: "concise", action: displayAction, meta: runningElapsedLabel, trailing: changeStatsElement }));
            }
            if (success === false || failureReason) {
                const parsedOutputError = extractErrorMessage(output);
                const errorMsg = failureReason || parsedOutputError || 'failed';
                const summarizeRawError = !failureReason && !isApprovalRejection && isStructuredToolError(output);
                const displayErrorMsg = isSearchLikeTool(toolName, command)
                    ? stripRgErrorLines(errorMsg).trim() || 'failed'
                    : errorMsg;
                // Truncate error message like standard mode truncates output
                const truncatedError = (() => {
                    const lines = displayErrorMsg.trimEnd().split('\n');
                    const maxLines = 3;
                    if (lines.length > maxLines + 1) {
                        const firstPart = lines.slice(0, maxLines).join('\n');
                        const lastLine = lines[lines.length - 1];
                        return `${firstPart}\n... (${lines.length - maxLines - 1} more lines)\n${lastLine}`;
                    }
                    return displayErrorMsg;
                })();
                return (React.createElement(Box, { flexDirection: "column" },
                    React.createElement(ToolHeader, { toolName: toolName, status: "failed", display: "concise", action: displayAction, trailing: changeStatsElement, textColor: textColor }),
                    matchCountElement,
                    summarizeRawError && (React.createElement(React.Fragment, null,
                        React.createElement(Text, { color: textColor || theme.textMuted }, "Tool failed."),
                        React.createElement(Text, { color: textColor || theme.textMuted }, "Review the error details and retry after correcting the issue."))),
                    matchCount === 0 && React.createElement(Text, { color: textColor || theme.textMuted }, truncatedError)));
            }
            // Success (one line)
            if (toolName === 'automatic_memory') {
                return (React.createElement(Box, { flexDirection: "column" },
                    renderStandardHeader(),
                    React.createElement(Text, { color: textColor || theme.textMuted }, output)));
            }
            if (toolName === 'ask_user') {
                const responseText = getConciseAskUserResponse(output);
                return (React.createElement(Box, { flexDirection: "column" },
                    React.createElement(ToolHeader, { toolName: toolName, status: "completed", display: "concise", action: displayAction, textColor: textColor }),
                    React.createElement(Text, { color: textColor || theme.textMuted },
                        " Response: ",
                        responseText)));
            }
            if (toolName === 'ask_mentor') {
                const firstParagraph = getFirstParagraph(output, 200);
                return (React.createElement(Box, { flexDirection: "column" },
                    React.createElement(ToolHeader, { toolName: toolName, status: "completed", display: "concise", action: displayAction, textColor: textColor }),
                    React.createElement(Text, { color: textColor || theme.textMuted },
                        " Response: ",
                        firstParagraph)));
            }
            return (React.createElement(Box, { flexDirection: "column" },
                React.createElement(ToolHeader, { toolName: toolName, status: "completed", display: "concise", action: displayAction, trailing: React.createElement(React.Fragment, null,
                        runCodeTroubleElement,
                        changeStatsElement), textColor: textColor }),
                matchCountElement,
                autoApprovalLabel));
        }
        const outputText = output?.trim() ? output : isRunning ? '(running...)' : isQueued ? '(queued)' : '(no output)';
        const displayed = outputText && outputText !== '(no output)' ? truncateOutputLines(output || '') : outputText;
        const actionableErrorSummary = success === false && !failureReason && !isApprovalRejection && isStructuredToolError(output) ? (React.createElement(React.Fragment, null,
            React.createElement(Text, { color: textColor || theme.textMuted }, "Tool failed."),
            React.createElement(Text, { color: textColor || theme.textMuted }, "Review the error details and retry after correcting the issue."))) : null;
        // Special handling for apply_patch
        if (toolName === TOOL_NAME_APPLY_PATCH && toolArgs) {
            if (hadApproval) {
                return (React.createElement(Box, { flexDirection: "column" },
                    React.createElement(Text, { color: success === false ? theme.danger : theme.toolOutput }, displayed)));
            }
            return (React.createElement(Box, { flexDirection: "column" },
                renderStandardHeader(),
                actionableErrorSummary,
                toolArgs.diff && success !== false && React.createElement(DiffView, { diff: toolArgs.diff }),
                failureReason && React.createElement(Text, { color: theme.danger },
                    "Error: ",
                    failureReason),
                React.createElement(Text, { color: success === false ? theme.danger : theme.toolOutput }, displayed)));
        }
        // Special handling for search_replace
        if (toolName === TOOL_NAME_SEARCH_REPLACE && toolArgs) {
            // For search_replace that had an approval prompt (user said 'y'), only show output
            if (hadApproval) {
                return (React.createElement(Box, { flexDirection: "column" },
                    React.createElement(Text, { color: success === false ? theme.danger : theme.toolOutput }, displayed)));
            }
            // For auto-approved search_replace (no approval prompt), show diff + output
            return (React.createElement(Box, { flexDirection: "column" },
                renderStandardHeader(),
                actionableErrorSummary,
                React.createElement(DiffView, { diff: diff }),
                failureReason && React.createElement(Text, { color: theme.danger },
                    "Error: ",
                    failureReason),
                React.createElement(Text, { color: success === false ? theme.danger : theme.toolOutput }, displayed)));
        }
        // Special handling for create_file
        if (toolName === TOOL_NAME_CREATE_FILE && toolArgs) {
            return (React.createElement(Box, { flexDirection: "column" },
                renderStandardHeader(),
                actionableErrorSummary,
                success !== false && React.createElement(DiffView, { diff: createFileDiffLines }),
                failureReason && React.createElement(Text, { color: theme.danger },
                    "Error: ",
                    failureReason),
                React.createElement(Text, { color: success === false ? theme.danger : theme.toolOutput }, displayed)));
        }
        if ((toolName === 'run_subagent_async' || isBackgroundSubagentLaunch) && success === false) {
            let launchError = output;
            try {
                const parsed = JSON.parse(output);
                launchError = parsed?.error?.message ?? parsed?.error ?? output;
            }
            catch {
                // The formatter may already have reduced the structured failure to text.
            }
            return (React.createElement(Box, { flexDirection: "column" },
                renderStandardHeader(),
                React.createElement(Box, { flexDirection: "column", marginTop: 0.5 },
                    React.createElement(ToolSection, { variant: "indent" },
                        React.createElement(Text, { color: theme.danger }, launchError)))));
        }
        if (displayMode === 'standard' && toolName === 'run_code' && runCodeTrace && !isApprovalRejection) {
            return React.createElement(RunCodeRenderer, { trace: runCodeTrace, success: success, renderStandardHeader: renderStandardHeader });
        }
        // Standard mode custom tool renderers
        if (displayMode === 'standard' && success !== false && !failureReason && !isRunning && !isQueued && !isWaiting) {
            if (toolName === 'read_file' || toolName === 'view_file') {
                const result = ReadFileRenderer({ output, renderStandardHeader });
                if (result)
                    return result;
            }
            if (toolName === 'grep') {
                const result = GrepRenderer({ output, renderStandardHeader });
                if (result)
                    return result;
            }
            if (toolName === 'glob') {
                const parsed = parseFindFilesOutput(output);
                if (parsed) {
                    const { files, note } = parsed;
                    return (React.createElement(Box, { flexDirection: "column" },
                        React.createElement(Box, { marginBottom: 1 }, renderStandardHeader()),
                        React.createElement(ToolSection, { variant: "indent" }, files.map((file, idx) => (React.createElement(Text, { key: idx, color: theme.toolOutput }, file)))),
                        note && (React.createElement(Box, { marginTop: 1 },
                            React.createElement(Text, { color: theme.warning }, note)))));
                }
            }
            if ((toolName === 'run_subagent' && !isBackgroundSubagentLaunch) || toolName === 'get_subagent_result') {
                const parsed = parseSubagentOutput(output, toolArgs);
                if (parsed) {
                    const { role: _role, status, toolsUsed, filesChanged, mainText } = parsed;
                    const _statusColor = status === 'completed' ? theme.textMuted : status === 'failed' ? theme.danger : theme.warning;
                    return (React.createElement(Box, { flexDirection: "column" },
                        renderStandardHeader(),
                        (toolsUsed || filesChanged) && (React.createElement(Box, { flexDirection: "column", marginY: 0.5 },
                            React.createElement(ToolSection, { variant: "indent" },
                                toolsUsed && (React.createElement(Text, { color: theme.textSubtle },
                                    "Tools: ",
                                    React.createElement(Text, { color: theme.text }, toolsUsed))),
                                filesChanged && (React.createElement(Text, { color: theme.textSubtle },
                                    "Changed: ",
                                    React.createElement(Text, { color: theme.text }, filesChanged)))))),
                        mainText && (React.createElement(Box, { flexDirection: "column", marginTop: 1 },
                            React.createElement(ToolSection, { variant: "panel" },
                                React.createElement(Text, { color: theme.toolOutput }, mainText))))));
                }
            }
            if (toolName === 'run_subagent_async' || isBackgroundSubagentLaunch) {
                let runId;
                try {
                    const parsed = JSON.parse(output);
                    runId = parsed?.runId;
                }
                catch {
                    // Fall back to treating the whole output as the runId.
                    runId = output;
                }
                return (React.createElement(Box, { flexDirection: "column" },
                    renderStandardHeader(),
                    React.createElement(Box, { flexDirection: "column", marginTop: 0.5 },
                        React.createElement(ToolSection, { variant: "indent" },
                            React.createElement(Box, null,
                                React.createElement(Text, { color: theme.textSubtle }, "Run ID: "),
                                React.createElement(Text, { color: theme.textMuted }, runId || output))))));
            }
            if (toolName === 'web_search') {
                const result = WebSearchRenderer({ output, renderStandardHeader });
                if (result)
                    return result;
            }
            if (toolName === 'web_fetch') {
                const result = WebFetchRenderer({ output, renderStandardHeader });
                if (result)
                    return result;
            }
            if (toolName === 'ask_mentor') {
                return (React.createElement(Box, { flexDirection: "column" },
                    renderStandardHeader(),
                    React.createElement(Box, { flexDirection: "column", marginTop: 1 },
                        React.createElement(ToolSection, { variant: "callout", title: "Mentor Response", tone: "accentAlt" },
                            React.createElement(Text, { color: theme.toolOutput }, output)))));
            }
            if (toolName === 'ask_user') {
                const options = toolArgs?.options;
                return (React.createElement(Box, { flexDirection: "column" },
                    renderStandardHeader(),
                    options && Array.isArray(options) && options.length > 0 && (React.createElement(Box, { flexDirection: "column", marginY: 0.5 },
                        React.createElement(ToolSection, { variant: "indent" },
                            React.createElement(Box, null,
                                React.createElement(Text, { color: theme.textSubtle }, "Options: "),
                                options.map((opt, idx) => (React.createElement(Text, { key: idx, color: idx === 0 ? theme.textMuted : theme.text },
                                    idx > 0 ? ', ' : '',
                                    "[",
                                    opt,
                                    "]",
                                    idx === 0 ? ' (Recommended)' : ''))))))),
                    React.createElement(Box, { flexDirection: "column", marginTop: 0.5 },
                        React.createElement(ToolSection, { variant: "indent" },
                            React.createElement(Box, null,
                                React.createElement(Text, { color: theme.textSubtle }, "Response: "),
                                React.createElement(Text, { color: theme.textMuted, bold: true }, output || 'No response yet'))))));
            }
            if (toolName === 'read_code_outline') {
                const parsed = parseCodeOutlineOutput(output);
                if (parsed) {
                    const { filePath: _filePath, lang: _lang, imports, exports, decls } = parsed;
                    return (React.createElement(Box, { flexDirection: "column" },
                        React.createElement(Box, { marginBottom: 1 }, renderStandardHeader()),
                        imports && imports.length > 0 && (React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
                            React.createElement(ToolSection, { variant: "indent" },
                                React.createElement(Text, { color: theme.warning, bold: true }, "Imports:"),
                                imports.map((imp, idx) => (React.createElement(Text, { key: idx, color: theme.toolOutput },
                                    ' ',
                                    "\u2022 ",
                                    imp)))))),
                        exports && exports.length > 0 && (React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
                            React.createElement(ToolSection, { variant: "indent" },
                                React.createElement(Text, { color: theme.textMuted, bold: true }, "Exports:"),
                                exports.map((exp, idx) => (React.createElement(Text, { key: idx, color: theme.toolOutput },
                                    ' ',
                                    "\u2022 ",
                                    exp)))))),
                        decls && decls.length > 0 && (React.createElement(ToolSection, { variant: "indent" },
                            React.createElement(Text, { color: theme.accent, bold: true }, "Declarations:"),
                            decls.map((decl, idx) => (React.createElement(Text, { key: idx, color: theme.toolOutput },
                                ' ',
                                "\u2022 ",
                                decl)))))));
                }
            }
            if (toolName === 'code_context_search') {
                const result = CodeContextSearchRenderer({ output, renderStandardHeader });
                if (result)
                    return result;
            }
            if (toolName && toolName.startsWith('memory_')) {
                const result = MemoryRenderer({
                    output,
                    toolName,
                    query: typeof toolArgs?.query === 'string' ? toolArgs.query : undefined,
                    renderStandardHeader,
                });
                if (result)
                    return result;
            }
        }
        // Special handling for approval-rejected shell commands: show the denial message
        // with a clear [DENIED] label so the user knows what was attempted and why.
        if (isApprovalRejection) {
            return (React.createElement(Box, { flexDirection: "column" },
                renderStandardHeader(),
                React.createElement(Text, { color: theme.danger },
                    "\u2192 DENIED: ",
                    denialReason)));
        }
        return (React.createElement(Box, { flexDirection: "column" },
            renderStandardHeader(),
            actionableErrorSummary,
            failureReason && React.createElement(Text, { color: theme.danger },
                "Error: ",
                failureReason),
            React.createElement(Text, { color: success === false ? theme.danger : theme.toolOutput }, displayed),
            autoApprovalLabel));
    };
    const content = renderContent();
    // A call inside a subagent's own feed is dense by design and is never framed.
    return isSubagent ? (content) : (React.createElement(ToolFrame, { status: statusKind, display: displayMode, toolName: toolName }, content));
};
export default React.memo(CommandMessage);
//# sourceMappingURL=CommandMessage.js.map