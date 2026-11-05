import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { ShellActivityProps, TaskPanelProps } from '../types.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';

/** `◆ running command`, as quiet as the working indicator it replaces. */
export const ZenShellActivity: FC<ShellActivityProps> = ({ command }) => {
  const theme = useTheme();
  const { faint } = useZenStyles();
  return (
    <Box paddingLeft={MARKER_COLUMNS}>
      <Text {...faint}>
        <Text color={theme.accent}>◆</Text> running <Text bold>{command}</Text>
      </Text>
    </Box>
  );
};

export const ZEN_TASK_PANEL_GUTTER = MARKER_COLUMNS;

export const ZenTaskPanel: FC<TaskPanelProps> = ({ header, children }) => {
  const { faint } = useZenStyles();
  return (
    <Box flexDirection="column" paddingLeft={MARKER_COLUMNS} marginBottom={1}>
      <Text {...faint}>{header}</Text>
      {children}
    </Box>
  );
};
