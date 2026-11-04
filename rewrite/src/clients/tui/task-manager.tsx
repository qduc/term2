import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from './presentation/components/theme.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import type { TaskView } from './state.js';
import { useTerminalSize } from './terminal.js';

/** Conservative terminal-cell width used before Ink performs physical layout. */
export const terminalTextWidth = (value: string): number =>
  Array.from(value).reduce((columns, point) => columns + (point.codePointAt(0)! > 0x7f ? 2 : 1), 0);

export const truncateTerminalText = (value: string, maxColumns: number): string => {
  if (terminalTextWidth(value) <= maxColumns) return value;
  const ellipsis = '…';
  const ellipsisWidth = terminalTextWidth(ellipsis);
  if (maxColumns <= ellipsisWidth) return ellipsis;
  let rendered = '';
  for (const point of value) {
    if (terminalTextWidth(rendered) + terminalTextWidth(point) + ellipsisWidth > maxColumns) break;
    rendered += point;
  }
  return `${rendered}${ellipsis}`;
};

/**
 * Port of legacy source/components/layout/BackgroundTaskManager.tsx: the ^G "Manage background tasks" frame
 * under the tasks panel. Rows, details, keys (↑↓, ⏎ details, b background for a foreground task, x force stop,
 * Esc/^G close) and feedback are legacy's; data comes from the snapshot's tasks and actions go through task
 * controls. Fields the snapshot does not carry (activity liveness, context usage) are left out.
 */
const MESSAGE_HORIZONTAL_PADDING = 2;
const TOOLS_ROW_LIMIT = 80;
const TOOL_NAME_LIMIT = 24;

const isLive = (task: TaskView): boolean =>
  task.status === 'running' || task.status === 'awaiting_interaction' || task.status === 'cancelling';
const isForeground = (task: TaskView): boolean => task.wire?.mode === 'foreground' && task.status !== 'cancelling';
const isActive = (task: TaskView): boolean => task.status === 'running' || task.status === 'awaiting_interaction';
const roleOf = (task: TaskView): string => task.wire?.role ?? task.role ?? 'agent';
const taskText = (task: TaskView): string => task.wire?.input ?? task.wire?.label ?? task.label;

/** Legacy statusText, from the snapshot status (a running background task is legacy's `active` phase). */
const managerStatusText = (task: TaskView): string => {
  if (task.status === 'cancelling') return 'cancelling';
  if (task.wire?.pendingQuestion) return 'waiting for answer';
  if (task.status === 'awaiting_interaction') return 'awaiting approval response';
  return 'active';
};

const compactLabel = (value: string, columns: number, prefix: string, suffix: string): string => {
  const firstLine = value.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  // The classic frame has two borders and horizontal padding on both sides.
  const frameWidth = 4;
  const overhead = frameWidth + terminalTextWidth(prefix) + terminalTextWidth(suffix);
  const labelBudget = Math.max(1, Math.min(72, columns - overhead));
  return truncateTerminalText(collapsed, labelBudget);
};

const formatElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
};

const formatToolCounts = (counts: readonly { readonly toolName: string; readonly count: number }[]): string => {
  const entries = counts.map(({ toolName, count }) => ({
    name: truncateTerminalText(toolName || 'tool', TOOL_NAME_LIMIT),
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
    if (terminalTextWidth(next) + terminalTextWidth(omitted) > TOOLS_ROW_LIMIT) break;
    rendered = next;
    renderedCount += 1;
  }
  const omittedCount = entries.length - renderedCount;
  if (!rendered) return `… +${omittedCount} more`;
  return omittedCount > 0 ? `${rendered}, … +${omittedCount} more` : rendered;
};

function DetailsView({ task }: { readonly task: TaskView }): React.ReactElement {
  const theme = useTheme();
  const wire = task.wire;
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2}>
      <Text color={theme.accentAlt}>ID: {task.id}</Text>
      <Text>State: {managerStatusText(task)}</Text>
      {wire?.kind === 'shell' ? (
        <>
          <Text wrap="wrap">Command: {taskText(task)}</Text>
          {wire.progress ? <Text wrap="wrap">Output: {wire.progress}</Text> : null}
          {wire.result?.error ? <Text color={theme.dangerSoft}>Error: {wire.result.error.message}</Text> : null}
        </>
      ) : (
        <>
          <Text>Role: {roleOf(task)}</Text>
          {wire?.name ? <Text>Name: {wire.name}</Text> : null}
          <Text wrap="wrap">Task: {taskText(task)}</Text>
          {wire?.startedAt !== undefined ? (
            <Text>Started: {formatElapsed(Date.now() - wire.startedAt)} ago</Text>
          ) : null}
          {wire?.model ? <Text>Model: {wire.model.model}</Text> : null}
          {wire?.model ? <Text>Provider: {wire.model.provider}</Text> : null}
          {wire?.result?.toolUseCounts?.length ? (
            <Text>Tools: {formatToolCounts(wire.result.toolUseCounts)}</Text>
          ) : null}
          {wire?.text ? <Text wrap="wrap">Current: {wire.text}</Text> : null}
        </>
      )}
    </Box>
  );
}

/** Keyboard-owned modal for live task inspection and per-item stop or move to background. */
export function TaskManager({
  tasks,
  onClose,
  onAction,
}: {
  readonly tasks: readonly TaskView[];
  readonly onClose: () => void;
  readonly onAction: (id: string, action: 'cancel' | 'check_in' | 'foreground' | 'background') => Promise<void>;
}): React.ReactElement | null {
  const theme = useTheme();
  const { MenuFrame, Hints } = useSkin();
  const { columns } = useTerminalSize();
  const labelColumns = Math.max(1, columns - MESSAGE_HORIZONTAL_PADDING * 2);
  const live = tasks.filter(isLive);
  const rows = [...live.filter(isForeground), ...live.filter((task) => !isForeground(task))];
  const [selectedKey, setSelectedKey] = useState<string | null>(rows[0]?.id ?? null);
  const [selectedOrdinal, setSelectedOrdinal] = useState(0);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [stopArmedKey, setStopArmedKey] = useState<string | null>(null);
  const [backgroundArmedKey, setBackgroundArmedKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const pending = useRef(false);
  const keyedIndex = selectedKey === null ? -1 : rows.findIndex((row) => row.id === selectedKey);
  const selectedIndex = keyedIndex >= 0 ? keyedIndex : Math.min(selectedOrdinal, Math.max(0, rows.length - 1));
  const selectedRow = rows[selectedIndex];
  const selectedForeground = selectedRow && isForeground(selectedRow) ? selectedRow : undefined;
  const selected = selectedRow && !isForeground(selectedRow) ? selectedRow : undefined;
  // Legacy openManager: ^G with no live task opens nothing.
  const empty = rows.length === 0;
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);

  const act = (id: string, action: 'cancel' | 'background', done: () => void, failure: string) => {
    if (pending.current) return;
    pending.current = true;
    onAction(id, action).then(
      () => {
        pending.current = false;
        done();
      },
      () => {
        pending.current = false;
        setFeedback(failure);
      },
    );
  };

  useInput((input, key) => {
    const ctrlG = (key.ctrl && input.toLowerCase() === 'g') || input === '\x07';
    if (key.escape || ctrlG) return onClose();
    if (key.upArrow || key.downArrow) {
      if (rows.length === 0) return;
      const nextIndex = key.upArrow
        ? (selectedIndex - 1 + rows.length) % rows.length
        : (selectedIndex + 1) % rows.length;
      setSelectedKey(rows[nextIndex]!.id);
      setSelectedOrdinal(nextIndex);
      setDetailsVisible(false);
      setStopArmedKey(null);
      setBackgroundArmedKey(null);
      setFeedback(null);
      return;
    }
    if (selectedForeground) {
      if (input.toLowerCase() === 'b') {
        setBackgroundArmedKey(selectedForeground.id);
        setFeedback(null);
        return;
      }
      if (!key.return) return;
      if (backgroundArmedKey !== selectedForeground.id) return setDetailsVisible(true);
      setBackgroundArmedKey(null);
      act(
        selectedForeground.id,
        'background',
        () => {
          setDetailsVisible(true);
          setFeedback('Moved to background');
        },
        'Task is no longer transferable',
      );
      return;
    }
    if (!selected) return;
    if (input.toLowerCase() === 'x' && isActive(selected)) {
      setStopArmedKey(selected.id);
      setFeedback(null);
      return;
    }
    if (!key.return) return;
    if (stopArmedKey === selected.id) {
      setStopArmedKey(null);
      act(
        selected.id,
        'cancel',
        () => {
          setDetailsVisible(true);
          setFeedback('Stop requested');
        },
        'Task is no longer active',
      );
      return;
    }
    setDetailsVisible(true);
    setFeedback(null);
  });

  if (empty) return null;
  const rowText = (task: TaskView, index: number) => {
    const marker = index === selectedIndex ? '❯' : ' ';
    const kind = task.wire?.kind === 'shell' ? 'Shell' : roleOf(task);
    const prefix = isForeground(task) ? `${marker} [${kind} · foreground] ` : `${marker} [${kind}] `;
    const status = isForeground(task) ? 'running' : managerStatusText(task);
    return `${prefix}${compactLabel(taskText(task), labelColumns, prefix, ` · ${status}`)}· ${status}`;
  };
  return (
    <Box flexDirection="column" marginBottom={1}>
      <MenuFrame
        title="Manage background tasks"
        borderColor={theme.accentAlt}
        hasItems={false}
        footerPlacement="outside"
      >
        {rows.map((task, index) => (
          <Text key={task.id} color={index === selectedIndex ? theme.text : theme.textSubtle}>
            {rowText(task, index)}
          </Text>
        ))}
        {detailsVisible && selectedForeground ? (
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            <Text color={theme.accentAlt}>
              {selectedForeground.wire?.kind === 'shell' ? 'Call ID' : 'Run ID'}: {selectedForeground.id}
            </Text>
            <Text>Status: running in foreground</Text>
            <Text wrap="wrap">
              {selectedForeground.wire?.kind === 'shell' ? 'Command' : 'Task'}: {taskText(selectedForeground)}
            </Text>
          </Box>
        ) : null}
        {detailsVisible && selected ? <DetailsView task={selected} /> : null}
        {stopArmedKey === selectedRow?.id ? (
          <Text color={theme.warning}>Press Enter to force stop this task, or Esc to close.</Text>
        ) : null}
        {backgroundArmedKey === selectedRow?.id ? (
          <Text color={theme.warning}>
            Press Enter to put this {selectedForeground?.wire?.kind === 'shell' ? 'shell' : 'subagent'} in the
            background, or Esc to close.
          </Text>
        ) : null}
        {feedback ? (
          <Text
            color={
              feedback === 'Stop requested' || feedback === 'Moved to background' ? theme.warning : theme.dangerSoft
            }
          >
            {feedback}
          </Text>
        ) : null}
        <Hints
          hints={[
            ['↑↓', 'navigate'],
            ['⏎', 'details'],
            ...(selectedForeground ? [['b', 'background'] as const] : []),
            ...(selected && isActive(selected) ? [['x', 'force stop'] as const] : []),
            ['Esc', 'close'],
          ]}
        />
      </MenuFrame>
    </Box>
  );
}
