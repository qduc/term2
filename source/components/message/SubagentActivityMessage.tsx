import React, { FC } from 'react';
import { Box, Text } from 'ink';
import CommandMessage from './CommandMessage.js';
import { getFirstParagraph } from './command-message-helpers.js';
import { COLOR_MUTED } from '../theme.js';
import type { CommandMessage as CommandMessageType } from '../../types/message.js';

type SubagentToolEntry = string | CommandMessageType;

type Props = {
  msg: {
    role?: string;
    task?: string;
    status?: string;
    async?: boolean;
    parentTool?: string;
    tools?: SubagentToolEntry[];
    finalText?: string;
    error?: string;
  };
};

const MAX_TOOL_LENGTH = 96;
const MAX_TASK_LENGTH = 300;

const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
};

const buildTitle = (
  role: string | undefined,
  task: string | undefined,
  async: boolean | undefined,
  parentTool: string | undefined,
): string => {
  const roleLabel = role ? `[${role}]` : '';
  const taskPreview = truncate(getFirstParagraph(task, 200).replace(/\s+/g, ' '), MAX_TASK_LENGTH);
  // Old logs did not retain parentTool. Their async entries originated from the
  // retired public tool, so preserve that title while new background runs use
  // the unified name recorded by the logger.
  const toolName = parentTool ?? (async ? 'run_subagent_async' : 'run_subagent');
  return [toolName, roleLabel, taskPreview].filter(Boolean).join(' ');
};

const formatSubagentStringTool = (tool: string, activityStatus?: string): string => {
  let statusChar = '✔';
  let cleaned = tool;

  if (tool.endsWith(' (Success)')) {
    statusChar = '✔';
    cleaned = tool.slice(0, -' (Success)'.length);
  } else if (tool.endsWith(' (Failed)')) {
    statusChar = '✖';
    cleaned = tool.slice(0, -' (Failed)'.length);
  } else if (/\s+\(Failed:.*\)$/.test(tool)) {
    statusChar = '✖';
    cleaned = tool.replace(/\s+\(Failed:.*\)$/, '');
  } else if (tool.endsWith(' (Cancelled)')) {
    statusChar = '✖';
    cleaned = tool.slice(0, -' (Cancelled)'.length);
  } else if (/\s+\(\d+\s+matches?\)$/.test(tool)) {
    statusChar = '✔';
    cleaned = tool.replace(/\s+\(\d+\s+matches?\)$/, '');
  } else {
    statusChar =
      activityStatus === 'running' ? '▶' : activityStatus === 'failed' || activityStatus === 'cancelled' ? '✖' : '✔';
  }

  return `${statusChar} ${cleaned}`;
};

export const isResultToolEvent = (tool: SubagentToolEntry): boolean => {
  if (tool && typeof tool === 'object') {
    return tool.status === 'completed' || tool.status === 'failed' || tool.success !== undefined;
  }
  if (typeof tool === 'string') {
    return (
      tool.endsWith(' (Success)') ||
      tool.endsWith(' (Failed)') ||
      tool.endsWith(' (Cancelled)') ||
      /\s+\(Failed:.*\)$/.test(tool) ||
      /\s+\(\d+\s+match(es)?\)$/.test(tool)
    );
  }
  return false;
};

const SubagentActivityMessage: FC<Props> = ({ msg }) => {
  const tools = Array.isArray(msg.tools) ? msg.tools.filter(isResultToolEvent).slice(-3) : [];
  const title = buildTitle(msg.role, msg.task, msg.async, msg.parentTool);
  const statusSuffix =
    msg.status && msg.status !== 'running'
      ? msg.status === 'failed' && msg.error
        ? ` — failed: ${msg.error}`
        : msg.status === 'backgrounded'
        ? ' — moved to background'
        : ` — ${msg.status}`
      : '';
  const color =
    msg.status === 'completed'
      ? 'green'
      : msg.status === 'failed'
      ? 'red'
      : msg.status === 'cancelled' || msg.status === 'interrupted' || msg.status === 'backgrounded'
      ? 'gray'
      : 'yellow';

  return (
    <Box flexDirection="column">
      <Text color={color}>
        $ {title}
        {statusSuffix}
      </Text>
      {msg.status === 'completed' && msg.finalText ? (
        <Text color={COLOR_MUTED}>{getFirstParagraph(msg.finalText, 500)}</Text>
      ) : (
        tools.map((tool, index) => {
          if (tool && typeof tool === 'object') {
            return (
              <Box key={index}>
                <CommandMessage
                  command={tool.command}
                  output={tool.output}
                  status={tool.status}
                  success={tool.success}
                  failureReason={tool.failureReason}
                  toolName={tool.toolName}
                  toolArgs={tool.toolArgs}
                  isApprovalRejection={tool.isApprovalRejection}
                  hadApproval={tool.hadApproval}
                  displayMode="concise"
                  textColor="#64748b"
                  isSubagent={true}
                />
              </Box>
            );
          }
          return (
            <Text key={`${tool}-${index}`} color={COLOR_MUTED}>
              {truncate(formatSubagentStringTool(tool as string, msg.status), MAX_TOOL_LENGTH)}
            </Text>
          );
        })
      )}
    </Box>
  );
};

export default React.memo(SubagentActivityMessage);
