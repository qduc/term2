import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import type {
  BackgroundSubagentTask,
  BackgroundSubagentTaskStatus,
  BackgroundSubagentTaskTool,
} from '../../services/subagents/subagent-notification-store.js';

type Props = {
  tasks: readonly BackgroundSubagentTask[];
  now: number;
};

const TASK_LABEL_LIMIT = 60;
const TOOL_LABEL_LIMIT = 60;

const formatRole = (role: string): string => {
  if (!role) return 'Agent';
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
};

const formatTaskLabel = (task: BackgroundSubagentTask): string => {
  const normalized = task.task.replaceAll(/\s+/g, ' ').trim();
  const fallback = `${formatRole(task.role)} background task`;
  const label = normalized || fallback;
  return label.length > TASK_LABEL_LIMIT ? `${label.slice(0, TASK_LABEL_LIMIT - 1)}…` : label;
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

const formatToolLabel = (tool: BackgroundSubagentTaskTool): string => {
  const label = tool.label.replaceAll(/\s+/g, ' ').trim();
  return label.length > TOOL_LABEL_LIMIT ? `${label.slice(0, TOOL_LABEL_LIMIT - 1)}…` : label;
};

export const formatBackgroundTaskElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
};

const formatTerminalStatus = (status: BackgroundSubagentTaskStatus): string => {
  switch (status) {
    case 'completed':
      return 'Completed recently';
    case 'failed':
      return 'Failed recently';
    case 'cancelled':
      return 'Cancelled recently';
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
        <Box key={task.runId} flexDirection="column">
          <Box flexDirection="row">
            <Box flexGrow={1}>
              <Text color="#64748b">• </Text>
              <Text color="#a5b4fc">[{formatRole(task.role)}]</Text>
              {task.name && <Text color="#c4b5fd"> {task.name}</Text>}
              <Text> {formatTaskLabel(task)}</Text>
              <Text color="#94a3b8">
                {' '}
                —{' '}
                {task.status === 'running'
                  ? `Running · ${formatBackgroundTaskElapsed(now - task.startedAt)}`
                  : formatTerminalStatus(task.status)}
              </Text>
            </Box>
            {task.usage?.prompt_tokens != null && (
              <Text color="#94a3b8">Ctx {formatContextTokens(task.usage.prompt_tokens)}</Text>
            )}
          </Box>
          {task.status === 'running' && task.lastTool && (
            <Box flexDirection="row">
              <Text color="#475569">{'  └ '}</Text>
              <Text color="#64748b">
                {TOOL_STATE_MARKER[task.lastTool.state]} {formatToolLabel(task.lastTool)}
              </Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
};

export default BackgroundTasksPanel;
