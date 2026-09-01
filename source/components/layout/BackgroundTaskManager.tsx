import React, { type FC, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  BackgroundTaskControlDetails,
  BackgroundTaskControlTarget,
  BackgroundTaskStopResult,
  ForegroundTaskControlDetails,
  ForegroundTransferCandidate,
  ForegroundTaskControlTarget,
  MoveForegroundToBackgroundResult,
} from '../../services/session/background-task-control.js';
import { sanitizeBackgroundTaskToolLabel } from '../../services/background-task-activity.js';
import { formatBackgroundTaskElapsed } from './BackgroundTasksPanel.js';
import { terminalTextWidth, truncateTerminalText } from './terminal-text-budget.js';
import { COLOR_ACCENT_ALT, COLOR_DANGER_SOFT, COLOR_TEXT, COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';

export type BackgroundTaskManagerProps = {
  enabled?: boolean;
  open: boolean;
  listDetails: () => readonly BackgroundTaskControlDetails[];
  getDetails: (target: BackgroundTaskControlTarget) => BackgroundTaskControlDetails | null;
  requestStop: (target: BackgroundTaskControlTarget) => BackgroundTaskStopResult;
  getForegroundTransferCandidate?: () => ForegroundTaskControlDetails | null;
  listForegroundTransferCandidates?: () => readonly ForegroundTransferCandidate[];
  moveForegroundToBackground?: (target: ForegroundTaskControlTarget) => MoveForegroundToBackgroundResult;
  onOpenChange?: (open: boolean) => void;
};

const taskTarget = (details: BackgroundTaskControlDetails): BackgroundTaskControlTarget => ({
  kind: details.kind,
  id: details.id,
});

const backgroundKey = (details: BackgroundTaskControlDetails): string => `${details.kind}:${details.id}`;
const foregroundKey = (details: ForegroundTransferCandidate): string =>
  details.kind === 'shell' ? `foreground-shell:${details.callId}` : `foreground-subagent:${details.runId}`;

const taskLabel = (details: BackgroundTaskControlDetails): string => {
  if (details.kind === 'shell') return details.command;
  return details.name ?? `${details.role}: ${details.taskPreview}`;
};

const isActive = (details: BackgroundTaskControlDetails): boolean =>
  details.status === 'running' || details.status === 'waiting_for_answer' || details.status === 'awaiting_approval';

const statusText = (details: BackgroundTaskControlDetails): string => {
  const status = details.status as string;
  if (status === 'failed') return 'failed · terminal';
  if (status === 'completed') return 'completed · terminal';
  if (status === 'timed_out') return 'timed out · terminal';
  if (status === 'cancelled') return 'cancelled · terminal';
  if (status === 'interrupted') return 'budget exhausted · terminal';
  const activity = details.activity;
  if (!activity) return status.replaceAll('_', ' ');
  if (activity.phase === 'waiting')
    return `awaiting ${activity.reason ?? 'provider'} response${activity.liveness.state === 'quiet' ? ' · quiet' : ''}`;
  if (activity.phase === 'cancelling') return 'cancelling';
  if (activity.phase === 'settled') return `${status.replaceAll('_', ' ')} · terminal`;
  return 'active';
};

const observationText = (details: BackgroundTaskControlDetails): string | undefined => {
  const observation = details.activity?.lastObservation;
  if (!observation) return undefined;
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

const formatContext = (promptTokens: number, contextWindow?: number): string => {
  const tokens =
    promptTokens >= 1000 ? `${(promptTokens / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(promptTokens);
  if (!contextWindow) return tokens;
  const max =
    contextWindow >= 1000 ? `${(contextWindow / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(contextWindow);
  return `${tokens} / ${max} (${((promptTokens / contextWindow) * 100).toFixed(1)}%)`;
};

export const BACKGROUND_TASK_MANAGER_TOOLS_ROW_LIMIT = 80;
const BACKGROUND_TASK_MANAGER_TOOL_NAME_LIMIT = 24;

const formatToolCounts = (counts: Record<string, number>): string => {
  const entries = Object.entries(counts).map(([name, count]) => ({
    name: truncateTerminalText(
      sanitizeBackgroundTaskToolLabel(name) || 'tool',
      BACKGROUND_TASK_MANAGER_TOOL_NAME_LIMIT,
    ),
    count: ` ×${count}`,
  }));
  let rendered = '';
  let renderedCount = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const separator = rendered ? ', ' : '';
    const remaining = entries.length - index - 1;
    const omitted = remaining > 0 ? `, … +${remaining} more` : '';
    const next = `${rendered}${separator}${entry.name}${entry.count}`;
    if (terminalTextWidth(next) + terminalTextWidth(omitted) > BACKGROUND_TASK_MANAGER_TOOLS_ROW_LIMIT) break;
    rendered = next;
    renderedCount += 1;
  }
  const omittedCount = entries.length - renderedCount;
  if (!rendered) return `… +${omittedCount} more`;
  return omittedCount > 0 ? `${rendered}, … +${omittedCount} more` : rendered;
};

const BackgroundTaskDetailsView: FC<{ details: BackgroundTaskControlDetails }> = ({ details }) => (
  <Box flexDirection="column" marginTop={1} paddingLeft={2}>
    <Text color={COLOR_ACCENT_ALT}>ID: {details.id}</Text>
    <Text>State: {statusText(details)}</Text>
    {details.activity && (
      <Text>
        Last observed: {formatBackgroundTaskElapsed(details.activity.liveness.ageMs)} ago
        {details.activity.liveness.state === 'quiet' ? ' (quiet)' : ''}
      </Text>
    )}
    {observationText(details) && <Text>Last activity: {observationText(details)}</Text>}
    {details.kind === 'shell' ? (
      <>
        <Text wrap="wrap">Command: {details.command}</Text>
        {details.output && <Text wrap="wrap">Output: {details.output}</Text>}
        {details.error && <Text color={COLOR_DANGER_SOFT}>Error: {details.error}</Text>}
      </>
    ) : (
      <>
        <Text>Role: {details.role}</Text>
        {details.name && <Text>Name: {details.name}</Text>}
        <Text wrap="wrap">Task: {details.task}</Text>
        <Text>Started: {formatBackgroundTaskElapsed(details.elapsedMs)} ago</Text>
        {details.model && <Text>Model: {details.model.id}</Text>}
        {details.model && <Text>Provider: {details.model.provider}</Text>}
        {details.latestUsage?.prompt_tokens !== undefined && (
          <Text>Context: {formatContext(details.latestUsage.prompt_tokens, details.model?.contextWindow)}</Text>
        )}
        {details.activity?.lastObservation.kind === 'retrying' && (
          <Text>
            Retries: {details.activity.lastObservation.attempt} of {details.activity.lastObservation.maxRetries}
          </Text>
        )}
        {details.lastToolName && <Text>Last tool: {details.lastToolName}</Text>}
        {Object.keys(details.toolCounts).length > 0 && <Text>Tools: {formatToolCounts(details.toolCounts)}</Text>}
        {details.currentText && <Text wrap="wrap">Current: {details.currentText}</Text>}
      </>
    )}
  </Box>
);

/** Keyboard-owned modal for retained background task inspection and per-item stop. */
const BackgroundTaskManager: FC<BackgroundTaskManagerProps> = ({
  enabled = true,
  open,
  listDetails,
  getDetails,
  requestStop,
  getForegroundTransferCandidate,
  listForegroundTransferCandidates,
  moveForegroundToBackground,
  onOpenChange,
}) => {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedOrdinal, setSelectedOrdinal] = useState(0);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [stopArmedKey, setStopArmedKey] = useState<string | null>(null);
  const [backgroundArmedKey, setBackgroundArmedKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [hiddenForeground, setHiddenForeground] = useState<ReadonlySet<string>>(new Set());

  const legacyForeground = getForegroundTransferCandidate?.() ?? null;
  const foregroundSource = listForegroundTransferCandidates?.() ?? (legacyForeground ? [legacyForeground] : []);
  const foreground = foregroundSource.filter((candidate) => !hiddenForeground.has(foregroundKey(candidate)));
  const tasks = listDetails();
  const rows = useMemo(
    () => [
      ...foreground.map((task) => ({ key: foregroundKey(task), kind: 'foreground' as const, task })),
      ...tasks.map((task) => ({ key: backgroundKey(task), kind: 'background' as const, task })),
    ],
    [foreground, tasks],
  );
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
    const next = listDetails();
    const legacy = getForegroundTransferCandidate?.() ?? null;
    const nextForeground = listForegroundTransferCandidates?.() ?? (legacy ? [legacy] : []);
    if (next.length === 0 && nextForeground.length === 0) return;
    setSelectedKey(nextForeground[0] ? foregroundKey(nextForeground[0]) : backgroundKey(next[0]!));
    setSelectedOrdinal(0);
    setDetailsVisible(false);
    setStopArmedKey(null);
    setBackgroundArmedKey(null);
    setHiddenForeground(new Set());
    setFeedback(null);
    onOpenChange?.(true);
  }, [getForegroundTransferCandidate, listDetails, listForegroundTransferCandidates, onOpenChange]);

  useEffect(() => {
    if (open && !enabled) close();
  }, [close, enabled, open]);

  useInput(
    (input, key) => {
      if (!open) {
        if (key.ctrl && input.toLowerCase() === 'g') openManager();
        return;
      }

      if (key.escape || (key.ctrl && input.toLowerCase() === 'g')) {
        close();
        return;
      }

      if (key.upArrow || key.downArrow) {
        if (rows.length === 0) return;
        const nextIndex = key.upArrow
          ? (selectedIndex - 1 + rows.length) % rows.length
          : (selectedIndex + 1) % rows.length;
        setSelectedKey(rows[nextIndex]!.key);
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
        if (!key.return) return;
        if (backgroundArmedKey !== selectedRow.key) {
          setDetailsVisible(true);
          return;
        }
        const target =
          selectedForeground.kind === 'shell'
            ? { kind: 'shell' as const, callId: selectedForeground.callId }
            : { kind: 'subagent' as const, runId: selectedForeground.runId };
        const result = moveForegroundToBackground?.(target);
        setBackgroundArmedKey(null);
        if (result?.ok) {
          setHiddenForeground((current) => new Set(current).add(selectedRow.key));
          setSelectedKey(backgroundKey(result.details));
          setSelectedOrdinal(0);
          setDetailsVisible(true);
          setFeedback('Moved to background');
        } else {
          setFeedback(result?.code === 'capacity' ? 'Background task limit reached' : 'Task is no longer transferable');
        }
        return;
      }
      if (!selected) return;
      if (input.toLowerCase() === 'x' && isActive(selected)) {
        setStopArmedKey(selectedRow.key);
        setFeedback(null);
        return;
      }
      if (!key.return) return;

      const target = taskTarget(selected);
      if (stopArmedKey === selectedRow.key) {
        const result = requestStop(target);
        setStopArmedKey(null);
        if (result.ok) {
          setDetailsVisible(true);
          setFeedback('Stop requested');
        } else {
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
    },
    { isActive: enabled },
  );

  if (!open) return null;
  const selectedForeground = selectedRow?.kind === 'foreground' ? selectedRow.task : null;
  const selected = selectedRow?.kind === 'background' ? selectedRow.task : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR_ACCENT_ALT} paddingX={1} marginBottom={1}>
      <Text bold color={COLOR_ACCENT_ALT}>
        Manage background tasks
      </Text>
      {foreground.map((candidate, index) => (
        <Text
          key={`${candidate.kind}:${candidate.kind === 'shell' ? candidate.callId : candidate.runId}`}
          color={index === selectedIndex ? COLOR_TEXT : COLOR_TEXT_SUBTLE}
        >
          {index === selectedIndex ? '❯' : ' '} [{candidate.kind === 'shell' ? 'Shell' : candidate.role} · foreground]{' '}
          {candidate.kind === 'shell' ? candidate.command : candidate.task} · running
        </Text>
      ))}
      {tasks.map((task, index) => {
        const displayIndex = index + foreground.length;
        return (
          <Text key={`${task.kind}:${task.id}`} color={displayIndex === selectedIndex ? COLOR_TEXT : COLOR_TEXT_SUBTLE}>
            {displayIndex === selectedIndex ? '❯' : ' '} [{task.kind === 'shell' ? 'Shell' : task.role}]{' '}
            {taskLabel(task)} · {statusText(task)}
          </Text>
        );
      })}
      {detailsVisible && selectedForeground && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text color={COLOR_ACCENT_ALT}>
            {selectedForeground.kind === 'shell' ? 'Call ID' : 'Run ID'}:{' '}
            {selectedForeground.kind === 'shell' ? selectedForeground.callId : selectedForeground.runId}
          </Text>
          <Text>Status: running in foreground</Text>
          <Text wrap="wrap">
            {selectedForeground.kind === 'shell' ? 'Command' : 'Task'}:{' '}
            {selectedForeground.kind === 'shell' ? selectedForeground.command : selectedForeground.task}
          </Text>
        </Box>
      )}
      {detailsVisible && selected && <BackgroundTaskDetailsView details={selected} />}
      {stopArmedKey === selectedRow?.key && (
        <Text color={COLOR_WARNING}>Press Enter to force stop this task, or Esc to close.</Text>
      )}
      {backgroundArmedKey === selectedRow?.key && (
        <Text color={COLOR_WARNING}>
          Press Enter to put this {selectedForeground?.kind === 'subagent' ? 'subagent' : 'shell'} in the background, or
          Esc to close.
        </Text>
      )}
      {feedback && (
        <Text
          color={
            feedback === 'Stop requested' || feedback === 'Moved to background' ? COLOR_WARNING : COLOR_DANGER_SOFT
          }
        >
          {feedback}
        </Text>
      )}
      <Text color={COLOR_TEXT_SUBTLE}>
        ↑↓ select · Enter details
        {selectedForeground ? ' · [b] Put in background' : ''}
        {selected && isActive(selected) ? ' · [x] Force stop' : ''} · Esc close
      </Text>
    </Box>
  );
};

export default BackgroundTaskManager;
