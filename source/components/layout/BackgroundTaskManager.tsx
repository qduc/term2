import React, { type FC, useCallback, useEffect, useState } from 'react';
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
import { formatBackgroundTaskElapsed } from './BackgroundTasksPanel.js';

export type BackgroundTaskManagerProps = {
  enabled?: boolean;
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

const taskLabel = (details: BackgroundTaskControlDetails): string => {
  if (details.kind === 'shell') return details.command;
  return details.name ?? `${details.role}: ${details.taskPreview}`;
};

const isActive = (details: BackgroundTaskControlDetails): boolean =>
  details.status === 'running' || details.status === 'waiting_for_answer';

const statusText = (details: BackgroundTaskControlDetails): string => {
  switch (details.status) {
    case 'waiting_for_answer':
      return 'waiting for answer';
    case 'timed_out':
      return 'timed out';
    default:
      return details.status.replaceAll('_', ' ');
  }
};

const formatToolCounts = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ');

const BackgroundTaskDetailsView: FC<{ details: BackgroundTaskControlDetails }> = ({ details }) => (
  <Box flexDirection="column" marginTop={1} paddingLeft={2}>
    <Text color="#c4b5fd">ID: {details.id}</Text>
    <Text>Status: {statusText(details)}</Text>
    {details.kind === 'shell' ? (
      <>
        <Text wrap="wrap">Command: {details.command}</Text>
        {details.output && <Text wrap="wrap">Output: {details.output}</Text>}
        {details.error && <Text color="#f87171">Error: {details.error}</Text>}
      </>
    ) : (
      <>
        <Text>Role: {details.role}</Text>
        {details.name && <Text>Name: {details.name}</Text>}
        <Text wrap="wrap">Task: {details.task}</Text>
        <Text>Elapsed: {formatBackgroundTaskElapsed(details.elapsedMs)}</Text>
        {Object.keys(details.toolCounts).length > 0 && <Text>Tools: {formatToolCounts(details.toolCounts)}</Text>}
        {details.currentText && <Text wrap="wrap">Current: {details.currentText}</Text>}
      </>
    )}
  </Box>
);

/** Keyboard-owned modal for retained background task inspection and per-item stop. */
const BackgroundTaskManager: FC<BackgroundTaskManagerProps> = ({
  enabled = true,
  listDetails,
  getDetails,
  requestStop,
  getForegroundTransferCandidate,
  listForegroundTransferCandidates,
  moveForegroundToBackground,
  onOpenChange,
}) => {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<readonly BackgroundTaskControlDetails[]>([]);
  const [foreground, setForeground] = useState<readonly ForegroundTransferCandidate[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [stopArmed, setStopArmed] = useState(false);
  const [backgroundArmed, setBackgroundArmed] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setDetailsVisible(false);
    setStopArmed(false);
    setBackgroundArmed(false);
    setFeedback(null);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const openManager = useCallback(() => {
    const next = listDetails();
    const legacyForeground = getForegroundTransferCandidate?.() ?? null;
    const nextForeground = listForegroundTransferCandidates?.() ?? (legacyForeground ? [legacyForeground] : []);
    if (next.length === 0 && nextForeground.length === 0) return;
    setTasks(next);
    setForeground(nextForeground);
    setSelectedIndex(0);
    setDetailsVisible(false);
    setStopArmed(false);
    setBackgroundArmed(false);
    setFeedback(null);
    setOpen(true);
    onOpenChange?.(true);
  }, [getForegroundTransferCandidate, listDetails, listForegroundTransferCandidates, onOpenChange]);

  useEffect(() => {
    if (open && !enabled) close();
  }, [close, enabled, open]);

  useInput(
    (input, key) => {
      if (!open) {
        if (key.ctrl && input.toLowerCase() === 'b') openManager();
        return;
      }

      if (key.escape || (key.ctrl && input.toLowerCase() === 'b')) {
        close();
        return;
      }

      if (key.upArrow || key.downArrow) {
        setSelectedIndex((current) => {
          const itemCount = tasks.length + foreground.length;
          if (itemCount === 0) return 0;
          return key.upArrow ? (current - 1 + itemCount) % itemCount : (current + 1) % itemCount;
        });
        setDetailsVisible(false);
        setStopArmed(false);
        setBackgroundArmed(false);
        setFeedback(null);
        return;
      }

      const selectedForeground = foreground[selectedIndex] ?? null;
      const taskIndex = selectedIndex - foreground.length;
      const selected = tasks[taskIndex];
      if (selectedForeground) {
        if (input.toLowerCase() === 'b' && moveForegroundToBackground) {
          setBackgroundArmed(true);
          setFeedback(null);
          return;
        }
        if (!key.return) return;
        if (!backgroundArmed) {
          setDetailsVisible(true);
          return;
        }
        const target =
          selectedForeground.kind === 'shell'
            ? { kind: 'shell' as const, callId: selectedForeground.callId }
            : { kind: 'subagent' as const, runId: selectedForeground.runId };
        const result = moveForegroundToBackground?.(target);
        setBackgroundArmed(false);
        if (result?.ok) {
          setForeground((current) => current.filter((candidate) => candidate !== selectedForeground));
          setTasks((current) => [result.details, ...current]);
          setSelectedIndex(0);
          setDetailsVisible(true);
          setFeedback('Moved to background');
        } else {
          setFeedback(
            result?.code === 'capacity' ? 'Background task limit reached' : 'Shell is no longer transferable',
          );
        }
        return;
      }
      if (!selected) return;
      if (input.toLowerCase() === 'x' && isActive(selected)) {
        setStopArmed(true);
        setFeedback(null);
        return;
      }
      if (!key.return) return;

      const target = taskTarget(selected);
      if (stopArmed) {
        const result = requestStop(target);
        setStopArmed(false);
        if (result.ok) {
          setTasks((current) => current.map((task, index) => (index === taskIndex ? result.details : task)));
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
      setTasks((current) => current.map((task, index) => (index === taskIndex ? latest : task)));
      setDetailsVisible(true);
      setFeedback(null);
    },
    { isActive: enabled },
  );

  if (!open) return null;
  const selectedForeground = foreground[selectedIndex] ?? null;
  const selected = tasks[selectedIndex - foreground.length];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#6366f1" paddingX={1} marginBottom={1}>
      <Text bold color="#a5b4fc">
        Manage background tasks
      </Text>
      {foreground.map((candidate, index) => (
        <Text
          key={`${candidate.kind}:${candidate.kind === 'shell' ? candidate.callId : candidate.runId}`}
          color={index === selectedIndex ? '#f8fafc' : '#64748b'}
        >
          {index === selectedIndex ? '❯' : ' '} [{candidate.kind === 'shell' ? 'Shell' : candidate.role} · foreground]{' '}
          {candidate.kind === 'shell' ? candidate.command : candidate.task} · running
        </Text>
      ))}
      {tasks.map((task, index) => {
        const displayIndex = index + foreground.length;
        return (
          <Text key={`${task.kind}:${task.id}`} color={displayIndex === selectedIndex ? '#f8fafc' : '#64748b'}>
            {displayIndex === selectedIndex ? '❯' : ' '} [{task.kind === 'shell' ? 'Shell' : task.role}]{' '}
            {taskLabel(task)} · {statusText(task)}
          </Text>
        );
      })}
      {detailsVisible && selectedForeground && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text color="#c4b5fd">
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
      {stopArmed && <Text color="#f59e0b">Press Enter to force stop this task, or Esc to close.</Text>}
      {backgroundArmed && (
        <Text color="#f59e0b">Press Enter to put this shell in the background, or Esc to close.</Text>
      )}
      {feedback && (
        <Text color={feedback === 'Stop requested' || feedback === 'Moved to background' ? '#f59e0b' : '#f87171'}>
          {feedback}
        </Text>
      )}
      <Text color="#64748b">
        ↑↓ select · Enter details
        {selectedForeground ? ' · [b] Put in background' : ''}
        {selected && isActive(selected) ? ' · [x] Force stop' : ''} · Esc close
      </Text>
    </Box>
  );
};

export default BackgroundTaskManager;
