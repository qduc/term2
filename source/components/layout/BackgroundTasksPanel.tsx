import React, { useRef, type FC } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { BackgroundTask } from '../../services/subagents/subagent-notification-store.js';
import type { BackgroundSubagentTaskTool } from '../../services/subagents/subagent-notification-store.js';
import type {
  BackgroundTaskControlDetails,
  ForegroundTransferCandidate,
} from '../../services/session/background-task-control.js';
import { normalizeLiveTaskRows, type LiveTaskRow } from './live-task-rows.js';
import { BACKGROUND_TASKS_PANEL_GRACE_MS } from './background-task-clock.js';
import { terminalTextWidth, truncateTerminalText } from './terminal-text-budget.js';
import {
  COLOR_ACCENT_ALT,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SUBTLE,
  TOOL_STATUS_COLOR,
  TOOL_STATUS_GLYPH,
  type ToolStatusKind,
} from '../theme.js';

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

/**
 * Compact clock for space-constrained panel rows (`45s`, `1:05`). Prose contexts
 * ("Started: 1m 05s ago" in the manager) keep `formatBackgroundTaskElapsed`, where
 * `1:05` would read as a time of day.
 */
export const formatBackgroundTaskClock = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
};

const formatPhase = (task: BackgroundTaskControlDetails, now: number, isNarrow: boolean): string => {
  const activity = task.activity;
  if (activity?.phase === 'settled') return formatTerminalStatus(task);
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
  if (isNarrow) return base;
  return `${base} · ${formatBackgroundTaskClock(now - task.startedAt)}`;
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
  const badge = `[${task.kind === 'shell' ? 'Shell' : formatRole(task.role)}${placement === 'foreground' ? ' ↑' : ''}]`;
  const rawPhase = isTerminal(task)
    ? formatTerminalStatus(task)
    : controlTask
    ? formatPhase(controlTask, now, isNarrow)
    : formatLiveStatus(task, now, isNarrow);
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
const formatTerminalStatus = (task: PanelTask): string => {
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

const isTerminal = (task: PanelTask): boolean =>
  task.status === 'completed' ||
  task.status === 'failed' ||
  task.status === 'timed_out' ||
  task.status === 'cancelled' ||
  task.status === 'interrupted';

const formatLiveStatus = (task: PanelTask, now: number, isNarrow: boolean): string => {
  const startedAt = 'startedAt' in task && typeof task.startedAt === 'number' ? task.startedAt : now;
  if (!isControlTask(task) || !task.activity) {
    return isNarrow ? 'Running' : `Running · ${formatBackgroundTaskClock(now - startedAt)}`;
  }
  return formatPhase(task, now, isNarrow);
};

const latestTool = (task: PanelTask): BackgroundSubagentTaskTool | undefined => {
  if (task.kind === 'shell' || isTerminal(task)) return undefined;
  if ('recentTools' in task && task.recentTools?.length) return task.recentTools.at(-1);
  return 'lastTool' in task ? task.lastTool : undefined;
};

const toolStatusKind = (state: BackgroundSubagentTaskTool['state']): ToolStatusKind =>
  state === 'success' ? 'completed' : state;

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
      <Text color={COLOR_TEXT_MUTED}>Tasks · {activeCount} active · ^G manage</Text>
      {visible.map(({ key, placement, task }) => {
        const isNarrow = columns < BACKGROUND_TASK_PANEL_MEDIUM_COLUMNS;
        const isWide = columns >= BACKGROUND_TASK_PANEL_WIDE_COLUMNS;
        const formattedRow = formatFirstLine({ task, placement, columns, now, isWide, isNarrow });
        const tool = latestTool(task);
        const toolStatus = tool ? toolStatusKind(tool.state) : undefined;
        return (
          <Box key={key} flexDirection="column">
            <Text>
              <Text color={COLOR_TEXT_SUBTLE}>• </Text>
              <Text color={COLOR_ACCENT_ALT}>{formattedRow.badge}</Text> <Text>{formattedRow.identity}</Text> ·{' '}
              <Text>{formattedRow.phase}</Text>
            </Text>
            {tool && toolStatus ? (
              <Text color={COLOR_TEXT_MUTED}>
                {'  └ '}
                <Text color={TOOL_STATUS_COLOR[toolStatus]}>{TOOL_STATUS_GLYPH[toolStatus]}</Text>{' '}
                {truncate(firstLine(tool.label).replaceAll(/\s+/g, ' '), Math.max(1, columns - 6))}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
};

export default BackgroundTasksPanel;
