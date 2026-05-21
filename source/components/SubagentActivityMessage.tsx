import React, { FC } from 'react';
import { Box, Text } from 'ink';

type Props = {
  msg: {
    role?: string;
    task?: string;
    status?: string;
    tools?: string[];
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

const SubagentActivityMessage: FC<Props> = ({ msg }) => {
  const tools = Array.isArray(msg.tools) ? msg.tools.slice(-3) : [];
  const title = buildTitle(msg.role, msg.task);

  return (
    <Box flexDirection="column">
      <Text color="yellow">$ {title}</Text>
      {tools.map((tool, index) => (
        <Text key={`${tool}-${index}`} color="#64748b">
          {truncate(tool, MAX_TOOL_LENGTH)}
        </Text>
      ))}
    </Box>
  );
};

export default React.memo(SubagentActivityMessage);
