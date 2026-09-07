import React, { useRef, type FC } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { BackgroundTask } from '../../services/subagents/subagent-notification-store.js';
import type {
  BackgroundTaskControlDetails,
  ForegroundTransferCandidate,
} from '../../services/session/background-task-control.js';
import { normalizeLiveTaskRows, type LiveTaskRow } from './live-task-rows.js';
import { BACKGROUND_TASKS_PANEL_GRACE_MS } from './background-task-clock.js';

export { BACKGROUND_TASKS_PANEL_GRACE_MS };
import { terminalTextWidth, truncateTerminalText } from './terminal-text-budget.js';
import { COLOR_ACCENT_ALT, COLOR_TEXT_MUTED, COLOR_TEXT_SUBTLE } from '../theme.js';

type Props = {
  tasks: readonly LiveTaskRow[] | readonly (BackgroundTask | BackgroundTaskControlDetails)[];
  now: number;
  /** Deterministic test seam; production uses Ink's stdout width. */
  columns?: number;
};

export const BACKGROUND_TASK_PANEL_NARROW_LABEL_LIMIT = 24;
export const BACKGROUND_TASK_PANEL_MEDIUM_LABEL_LIMIT = 36;
export const BACKGROUND_TASK_PANEL_WIDE_LABEL_LIMIT = 60;
const NAME_LIMIT = 24;
export const BACKGROUND_TASK_PANEL_MEDIUM_COLUMNS = 72;
export const BACKGROUND_TASK_PANEL_WIDE_COLUMNS = 104;
const BACKGROUND_TASK_PANEL_MIN_IDENTITY_COLUMNS = 6;

const truncate = truncateTerminalText;

// Multi-line prompts are common for subagent tasks; only the first line is a label.
const firstLine = (value: string): string =>
  value
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? '';

const formatRole = (role: string): string => {
  if (!role) return 'Agent';
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
};

type PanelTask = BackgroundTask | BackgroundTaskControlDetails | ForegroundTransferCandidate;

const isControlTask = (task: PanelTask): task is BackgroundTaskControlDetails => 'id' in task;

const formatTaskLabel = (task: PanelTask): string => {
  if (task.kind === 'shell') {
    return firstLine(task.command).replaceAll(/\s+/g, ' ');
  }
  const normalized = firstLine('taskPreview' in task ? task.taskPreview : task.task).replaceAll(/\s+/g, ' ');
  const label = normalized || `${formatRole(task.role)} background task`;
  return 'name' in task && task.name ? `${truncate(task.name, NAME_LIMIT)} ${label}` : label;
};

export const formatBackgroundTaskElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
};

const formatPhase = (task: BackgroundTaskControlDetails, now: number): string => {
  const elapsed = formatBackgroundTaskElapsed(now - task.startedAt);
  const activity = task.activity;
  if (!activity) return `Running · ${elapsed}`;
  if (activity.phase === 'waiting') return `Awaiting ${activity.reason ?? 'provider'} response · ${elapsed}`;
  if (activity.phase === 'cancelling') return `Cancelling · ${elapsed}`;
  if (activity.phase === 'settled') return formatTerminalStatus(task);
  return `Active · ${elapsed}`;
};

const formatCompactPhase = (task: BackgroundTaskControlDetails, now: number, isNarrow: boolean): string => {
  const activity = task.activity;
  if (activity?.phase === 'settled') return formatTerminalStatus(task);
  const base = !activity
    ? 'Running'
    : activity.phase === 'waiting'
    ? 'Waiting'
    : activity.phase === 'cancelling'
    ? 'Cancelling'
    : 'Active';
  if (isNarrow) return base;
  return `${base} · ${formatBackgroundTaskElapsed(now - task.startedAt)}`;
};

const formatCompactTerminalStatus = (task: PanelTask): string => {
  switch (task.status) {
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'timed_out':
      return 'Timed out';
    case 'interrupted':
      return 'Interrupted';
    default:
      return 'Running';
  }
};

const formatFirstLine = ({
  task,
  placement,
  columns,
  now,
  isWide,
  isNarrow,
}: {
  task: PanelTask;
  placement: 'foreground' | 'background';
  columns: number;
  now: number;
  isWide: boolean;
  isNarrow: boolean;
}): { badge: string; identity: string; phase: string } => {
  const controlTask = isControlTask(task) ? task : undefined;
  const badge = `[${task.kind === 'shell' ? 'Shell' : formatRole(task.role)}${
    placement === 'foreground' ? ' · foreground' : ''
  }]`;
  const rawPhase = isTerminal(task)
    ? isNarrow
      ? formatCompactTerminalStatus(task)
      : formatTerminalStatus(task)
    : controlTask
    ? isWide
      ? formatPhase(controlTask, now)
      : formatCompactPhase(controlTask, now, isNarrow)
    : isNarrow
    ? 'Running'
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

const formatTerminalStatus = (task: PanelTask): string => {
  switch (task.status) {
    case 'completed':
      return 'Completed recently';
    case 'failed':
      const error = 'error' in task ? task.error : undefined;
      return isControlTask(task)
        ? error
          ? `Failed · terminal (${error})`
          : 'Failed · terminal'
        : error
        ? `Failed recently (${error})`
        : 'Failed recently';
    case 'cancelled':
      return 'Cancelled recently';
    case 'timed_out':
      return 'Timed out recently';
    case 'interrupted':
      return 'Interrupted recently (budget exhausted)';
    default:
      return 'Running';
  }
};

const isTerminal = (task: PanelTask): boolean =>
  task.status === 'completed' ||
  task.status === 'failed' ||
  task.status === 'timed_out' ||
  task.status === 'cancelled' ||
  task.status === 'interrupted';

const formatLiveStatus = (task: PanelTask, now: number): string => {
  const startedAt = 'startedAt' in task && typeof task.startedAt === 'number' ? task.startedAt : now;
  if (!isControlTask(task) || !task.activity) return `Running · ${formatBackgroundTaskElapsed(now - startedAt)}`;
  return formatPhase(task, now);
};

const BackgroundTasksPanel: FC<Props> = ({ tasks, now, columns: testColumns }) => {
  const { stdout } = useStdout();
  const columns = testColumns ?? stdout.columns ?? BACKGROUND_TASK_PANEL_MEDIUM_COLUMNS;
  const rows = normalizeLiveTaskRows(tasks);
  // The registry keeps terminal entries around indefinitely, so each settled row
  // lingers briefly — long enough to read its outcome — then drops off on its own.
  const settledAtRef = useRef(new Map<string, number>());
  const settledAt = settledAtRef.current;
  const liveKeys = new Set(rows.map((row) => row.key));
  for (const key of settledAt.keys()) if (!liveKeys.has(key)) settledAt.delete(key);

  const visible = rows.filter((row) => {
    if (!isTerminal(row.task)) {
      settledAt.delete(row.key);
      return true;
    }
    const since = settledAt.get(row.key) ?? now;
    settledAt.set(row.key, since);
    return now - since < BACKGROUND_TASKS_PANEL_GRACE_MS;
  });

  if (visible.length === 0) return null;

  const activeCount = visible.filter((row) => !isTerminal(row.task)).length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={COLOR_TEXT_MUTED}>Tasks · {activeCount} active · Ctrl+G manage</Text>
      {visible.map(({ key, placement, task }) => {
        const isNarrow = columns < BACKGROUND_TASK_PANEL_MEDIUM_COLUMNS;
        const isWide = columns >= BACKGROUND_TASK_PANEL_WIDE_COLUMNS;
        const firstLine = formatFirstLine({ task, placement, columns, now, isWide, isNarrow });
        return (
          <Box key={key}>
            <Text>
              <Text color={COLOR_TEXT_SUBTLE}>• </Text>
              <Text color={COLOR_ACCENT_ALT}>{firstLine.badge}</Text> <Text>{firstLine.identity}</Text> ·{' '}
              <Text>{firstLine.phase}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};

export default BackgroundTasksPanel;
