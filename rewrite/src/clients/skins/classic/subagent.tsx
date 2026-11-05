import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { SubagentFeedProps } from '../types.js';

/** `$ title — status`, then the final answer's first paragraph or the latest calls, unindented. */
export const ClassicSubagentFeed: FC<SubagentFeedProps> = ({ title, statusSuffix, tone, summary, children }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={theme[tone]}>
        $ {title}
        {statusSuffix}
      </Text>
      {summary !== undefined ? <Text color={theme.textSubtle}>{summary}</Text> : children}
    </Box>
  );
};
