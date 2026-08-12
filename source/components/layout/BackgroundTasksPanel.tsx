import React, { useRef, type FC } from 'react';
import { Box, Text } from 'ink';
import type {
  BackgroundTask,
  BackgroundSubagentTaskTool,
} from '../../services/subagents/subagent-notification-store.js';
import type { BackgroundTaskControlDetails } from '../../services/session/background-task-control.js';

type Props = {
  tasks: readonly (BackgroundTask | BackgroundTaskControlDetails)[];
  now: number;
};

const TASK_LABEL_LIMIT = 60;
const TOOL_LABEL_LIMIT = 60;
const NAME_LIMIT = 24;

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

type PanelTask = BackgroundTask | BackgroundTaskControlDetails;

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

const formatBackgroundTaskActivityAge = (now: number, lastActivityAt: number): string =>
  `last activity ${formatBackgroundTaskElapsed(now - lastActivityAt)} ago`;

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
  if (!isControlTask(task) || !task.activity) return `Running · ${formatBackgroundTaskElapsed(now - task.startedAt)}`;
  const activityAge = formatBackgroundTaskActivityAge(now, task.activity.lastActivityAt);
  switch (task.activity.state) {
    case 'active':
      return `Active · ${formatBackgroundTaskElapsed(now - task.startedAt)} · ${activityAge}`;
    case 'waiting':
      return `Waiting for ${task.activity.reason ?? 'provider'} · ${activityAge}`;
    case 'quiet':
      return `Quiet · no observed progress · ${activityAge} · still running`;
    case 'cancelling':
      return `Cancelling · ${activityAge}`;
    case 'settled':
      return formatTerminalStatus(task);
  }
};

/** How long a settled task stays on the panel after it finishes. */
export const BACKGROUND_TASKS_PANEL_GRACE_MS = 5_000;

const taskKey = (task: PanelTask): string =>
  task.kind === 'shell' ? ('id' in task ? task.id : task.jobId) : 'id' in task ? task.id : task.runId;

const BackgroundTasksPanel: FC<Props> = ({ tasks, now }) => {
  // The registry keeps terminal entries around indefinitely, so each settled row
  // lingers briefly — long enough to read its outcome — then drops off on its own.
  const settledAtRef = useRef(new Map<string, number>());
  const settledAt = settledAtRef.current;
  const liveKeys = new Set(tasks.map(taskKey));
  for (const key of settledAt.keys()) if (!liveKeys.has(key)) settledAt.delete(key);

  const visible = tasks.filter((task) => {
    const key = taskKey(task);
    if (!isTerminal(task)) {
      settledAt.delete(key);
      return true;
    }
    const since = settledAt.get(key) ?? now;
    settledAt.set(key, since);
    return now - since < BACKGROUND_TASKS_PANEL_GRACE_MS;
  });

  if (visible.length === 0) return null;

  const activeCount = visible.filter((task) => !isTerminal(task)).length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="#94a3b8">Background tasks · {activeCount} active · Ctrl+G manage</Text>
      {visible.map((task) => (
        <Box key={taskKey(task)} flexDirection="column">
          <Box flexDirection="row">
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end">
                <Text color="#64748b">• </Text>
                <Text color="#a5b4fc">[{task.kind === 'shell' ? 'Shell' : formatRole(task.role)}]</Text>
                {task.kind !== 'shell' && task.name && <Text color="#c4b5fd"> {truncate(task.name, NAME_LIMIT)}</Text>}
                <Text> {formatTaskLabel(task)}</Text>
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color="#94a3b8" wrap="truncate-end">
                {'  '}
                {!isTerminal(task) ? formatLiveStatus(task, now) : formatTerminalStatus(task)}
                {task.kind !== 'shell' && !isControlTask(task) && task.usage?.prompt_tokens != null
                  ? ` · Ctx ${formatContextTokens(task.usage.prompt_tokens)}`
                  : ''}
              </Text>
            </Box>
          </Box>
          {task.kind !== 'shell' && !isControlTask(task) && task.status === 'running' && task.lastTool && (
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
      ))}
    </Box>
  );
};

export default BackgroundTasksPanel;
