import React, { FC } from 'react';
import { Box, Text } from 'ink';
import CommandMessage from './CommandMessage.js';
import { COLOR_MUTED } from '../theme.js';

type Props = {
  msg: {
    role?: string;
    task?: string;
    status?: string;
    tools?: (string | any)[];
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

const buildTitle = (role: string | undefined, task: string | undefined): string => {
  const roleLabel = role ? `[${role}]` : '';
  const firstParagraph =
    task
      ?.split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() || '';
  const taskPreview = truncate(firstParagraph, MAX_TASK_LENGTH);
  return ['run_subagent', roleLabel, taskPreview].filter(Boolean).join(' ');
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
    statusChar = activityStatus === 'running' ? '▶' : '✔';
  }

  return `${statusChar} ${cleaned}`;
};

const SubagentActivityMessage: FC<Props> = ({ msg }) => {
  const tools = Array.isArray(msg.tools) ? msg.tools.slice(-3) : [];
  const title = buildTitle(msg.role, msg.task);
  const statusSuffix = msg.status && msg.status !== 'running' ? ` — ${msg.status}` : '';
  const color =
    msg.status === 'completed'
      ? 'green'
      : msg.status === 'failed'
      ? 'red'
      : msg.status === 'cancelled'
      ? 'gray'
      : 'yellow';

  return (
    <Box flexDirection="column">
      <Text color={color}>
        $ {title}
        {statusSuffix}
      </Text>
      {tools.map((tool, index) => {
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
      })}
    </Box>
  );
};

export default React.memo(SubagentActivityMessage);
