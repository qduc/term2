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

const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
};

const SubagentActivityMessage: FC<Props> = ({ msg }) => {
  const tools = Array.isArray(msg.tools) ? msg.tools.slice(-3) : [];

  return (
    <Box flexDirection="column">
      {tools.map((tool, index) => (
        <Text key={`${tool}-${index}`} color="#64748b">
          {truncate(tool, MAX_TOOL_LENGTH)}
        </Text>
      ))}
    </Box>
  );
};

export default React.memo(SubagentActivityMessage);
