import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import type {
  BackgroundTask,
  BackgroundSubagentTaskTool,
} from '../../services/subagents/subagent-notification-store.js';

type Props = {
  tasks: readonly BackgroundTask[];
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

const formatTaskLabel = (task: BackgroundTask): string => {
  if (task.kind === 'shell') {
    return truncate(firstLine(task.command).replaceAll(/\s+/g, ' '), TASK_LABEL_LIMIT);
  }
  const normalized = firstLine(task.task).replaceAll(/\s+/g, ' ');
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

const formatTerminalStatus = (task: BackgroundTask): string => {
  switch (task.status) {
    case 'completed':
      return 'Completed recently';
    case 'failed':
      return task.error ? `Failed recently (${task.error})` : 'Failed recently';
    case 'cancelled':
      return 'Cancelled recently';
    case 'timed_out':
      return 'Timed out recently';
    default:
      return 'Running';
  }
};

const BackgroundTasksPanel: FC<Props> = ({ tasks, now }) => {
  if (tasks.length === 0) return null;

  const activeCount = tasks.filter((task) => task.status === 'running').length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="#94a3b8">Background tasks · {activeCount} active</Text>
      {tasks.map((task) => (
        <Box key={task.kind === 'shell' ? task.jobId : task.runId} flexDirection="column">
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
                {task.status === 'running'
                  ? `Running · ${formatBackgroundTaskElapsed(now - task.startedAt)}`
                  : formatTerminalStatus(task)}
                {task.kind !== 'shell' && task.usage?.prompt_tokens != null
                  ? ` · Ctx ${formatContextTokens(task.usage.prompt_tokens)}`
                  : ''}
              </Text>
            </Box>
          </Box>
          {task.kind !== 'shell' && task.status === 'running' && task.lastTool && (
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
