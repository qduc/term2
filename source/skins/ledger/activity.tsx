import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { ShellActivityProps, TaskPanelProps } from '../types.js';
import { Chip } from './chip.js';

/** A `SHELL` chip, then the command. */
export const LedgerShellActivity: FC<ShellActivityProps> = ({ command }) => {
  const theme = useTheme();
  return (
    <Box>
      <Box flexShrink={0} marginRight={1}>
        <Chip tone="danger" bold>
          SHELL
        </Chip>
      </Box>
      <Box flexShrink={1}>
        <Text color={theme.text} bold>
          {command}
        </Text>
      </Box>
    </Box>
  );
};

export const LedgerTaskPanel: FC<TaskPanelProps> = ({ header, children }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box alignSelf="flex-start">
      <Chip tone="accentAlt" bold>
        {header}
      </Chip>
    </Box>
    {children}
  </Box>
);
