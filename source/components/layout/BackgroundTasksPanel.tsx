import React, { useRef, type FC } from 'react';
import { Box, Text, useStdout } from 'ink';
import type {
  BackgroundTask,
  BackgroundSubagentTaskTool,
} from '../../services/subagents/subagent-notification-store.js';
import type {
  BackgroundTaskControlDetails,
  ForegroundTransferCandidate,
} from '../../services/session/background-task-control.js';
import { normalizeLiveTaskRows, type LiveTaskRow } from './live-task-rows.js';

type Props = {
  tasks: readonly LiveTaskRow[] | readonly (BackgroundTask | BackgroundTaskControlDetails)[];
  now: number;
  /** Deterministic test seam; production uses Ink's stdout width. */
  columns?: number;
};

const TASK_LABEL_LIMIT = 60;
const TOOL_LABEL_LIMIT = 60;
const NAME_LIMIT = 24;
export const BACKGROUND_TASK_PANEL_MEDIUM_COLUMNS = 72;
export const BACKGROUND_TASK_PANEL_WIDE_COLUMNS = 104;
export const BACKGROUND_TASK_PANEL_HIGH_CONTEXT_RATIO = 0.8;

const truncate = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

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
    return truncate(firstLine(task.command).replaceAll(/\s+/g, ' '), TASK_LABEL_LIMIT);
  }
  const normalized = firstLine('taskPreview' in task ? task.taskPreview : task.task).replaceAll(/\s+/g, ' ');
  const label = normalized || `${formatRole(task.role)} background task`;
  return truncate(label, TASK_LABEL_LIMIT);
};

const formatContextTokens = (tokens: number): string => {
  if (tokens < 1_000) return String(tokens);
  return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
};

// Matches the status vocabulary of SubagentActivityMessage so foreground and
// background subagent activity read the same way.
const TOOL_STATE_MARKER: Record<BackgroundSubagentTaskTool['state'], string> = {
  running: '▶',
  success: '✔',
  failed: '✖',
};

const formatToolLabel = (tool: BackgroundSubagentTaskTool): string =>
  truncate(firstLine(tool.label).replaceAll(/\s+/g, ' '), TOOL_LABEL_LIMIT);

export const formatBackgroundTaskElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
};

const formatObservation = (task: BackgroundTaskControlDetails): string => {
  const observation = task.activity?.lastObservation;
  if (!observation) return 'No observation recorded';
  switch (observation.kind) {
    case 'request_dispatched':
      return 'Request handed to model runtime';
    case 'response_started':
      return 'Response started';
    case 'text_received':
      return 'Text received';
    case 'tool_started':
      return `Tool started: ${observation.toolName}`;
    case 'tool_completed': {
      return observation.toolName ? `Tool completed: ${observation.toolName}` : 'Tool completed';
    }
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

const formatPhase = (task: BackgroundTaskControlDetails): string => {
  const activity = task.activity;
  if (!activity) return 'Running';
  if (activity.phase === 'waiting') return `Awaiting ${activity.reason ?? 'provider'} response`;
  if (activity.phase === 'cancelling') return 'Cancelling';
  if (activity.phase === 'settled') return formatTerminalStatus(task);
  return 'Active';
};

const formatLiveness = (task: BackgroundTaskControlDetails): string => {
  const liveness = task.activity?.liveness;
  if (!liveness) return '';
  const age = formatBackgroundTaskElapsed(liveness.ageMs);
  return liveness.state === 'quiet' ? `no activity observed for ${age}` : `${age} ago`;
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
    default:
      return 'Running';
  }
};

const isTerminal = (task: PanelTask): boolean =>
  task.status === 'completed' || task.status === 'failed' || task.status === 'timed_out' || task.status === 'cancelled';

const formatLiveStatus = (task: PanelTask, now: number): string => {
  const startedAt = 'startedAt' in task && typeof task.startedAt === 'number' ? task.startedAt : now;
  if (!isControlTask(task) || !task.activity) return `Running · ${formatBackgroundTaskElapsed(now - startedAt)}`;
  return `${formatPhase(task)} · ${formatLiveness(task)}`;
};

/** How long a settled task stays on the panel after it finishes. */
export const BACKGROUND_TASKS_PANEL_GRACE_MS = 5_000;

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
      <Text color="#94a3b8">Tasks · {activeCount} active · Ctrl+G manage</Text>
      {visible.map(({ key, placement, task }) => {
        const controlTask = isControlTask(task) ? task : undefined;
        const subagentTask = controlTask?.kind === 'subagent' ? controlTask : undefined;
        const context = subagentTask?.latestUsage?.prompt_tokens;
        const ratio =
          context !== undefined && subagentTask?.model?.contextWindow
            ? context / subagentTask.model.contextWindow
            : undefined;
        const showHighContext =
          columns >= BACKGROUND_TASK_PANEL_WIDE_COLUMNS &&
          ratio !== undefined &&
          ratio >= BACKGROUND_TASK_PANEL_HIGH_CONTEXT_RATIO;
        const isNarrow = columns < BACKGROUND_TASK_PANEL_MEDIUM_COLUMNS;
        const status = !isTerminal(task) ? formatLiveStatus(task, now) : formatTerminalStatus(task);
        return (
          <Box key={key} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color="#64748b">• </Text>
              <Text color="#a5b4fc">
                [{task.kind === 'shell' ? 'Shell' : formatRole(task.role)}
                {placement === 'foreground' ? ' · foreground' : ''}]
              </Text>
              {task.kind !== 'shell' && 'name' in task && task.name && (
                <Text color="#c4b5fd"> {truncate(task.name, NAME_LIMIT)}</Text>
              )}{' '}
              <Text>
                {formatTaskLabel(task)} · {isNarrow ? status : controlTask ? formatPhase(controlTask) : status}
              </Text>
            </Text>
            {!isNarrow && controlTask && !isTerminal(task) && (
              <Text color="#94a3b8" wrap="truncate-end">
                {' '}
                {columns >= BACKGROUND_TASK_PANEL_WIDE_COLUMNS
                  ? `${formatObservation(controlTask)} · ${formatLiveness(controlTask)}`
                  : formatObservation(controlTask)}
                {showHighContext
                  ? ` · Ctx ${formatContextTokens(context!)} / ${formatContextTokens(
                      subagentTask!.model!.contextWindow!,
                    )} (${(ratio! * 100).toFixed(1)}%)`
                  : ''}
              </Text>
            )}
            {task.kind !== 'shell' &&
              !isControlTask(task) &&
              task.status === 'running' &&
              'lastTool' in task &&
              task.lastTool && (
                <Box flexDirection="row">
                  <Text color="#475569">{'  └ '}</Text>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text color="#64748b" wrap="truncate-end">
                      {TOOL_STATE_MARKER[task.lastTool.state]} {formatToolLabel(task.lastTool)}
                    </Text>
                  </Box>
                </Box>
              )}
          </Box>
        );
      })}
    </Box>
  );
};

export default BackgroundTasksPanel;
