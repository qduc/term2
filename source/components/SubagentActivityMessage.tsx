import React, { FC, useMemo } from 'react';
import { Box, Text } from 'ink';

type Props = {
  msg: {
    role?: string;
    task?: string;
    status?: string;
    tools?: string[];
  };
};

const MAX_TASK_LENGTH = 72;
const MAX_TOOL_LENGTH = 96;

const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
};

const SubagentActivityMessage: FC<Props> = ({ msg }) => {
  const task = useMemo(() => truncate((msg.task ?? '').replace(/\s+/g, ' ').trim(), MAX_TASK_LENGTH), [msg.task]);
  const tools = Array.isArray(msg.tools) ? msg.tools.slice(-3) : [];
  const isRunning = msg.status === 'running';

  return (
    <Box flexDirection="column">
      <Text color={isRunning ? 'yellow' : '#64748b'}>
        subagent <Text bold>{msg.role ?? 'subagent'}</Text>
        {task ? <Text> {task}</Text> : null}
      </Text>
      {tools.map((tool, index) => (
        <Text key={`${tool}-${index}`} color="#64748b">
          {truncate(tool, MAX_TOOL_LENGTH)}
        </Text>
      ))}
    </Box>
  );
};

export default React.memo(SubagentActivityMessage);
