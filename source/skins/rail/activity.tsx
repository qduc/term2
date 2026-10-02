import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { ShellActivityProps, TaskPanelProps } from '../types.js';
import { RAIL_THIN, Rail } from './parts.js';

/** `$ command`: the shell marker the prompt uses, then the command, quiet. */
export const RailShellActivity: FC<ShellActivityProps> = ({ command }) => {
  const theme = useTheme();
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={theme.danger} bold>
          $
        </Text>
      </Box>
      <Box flexShrink={1}>
        <Text color={theme.textMuted}>{command}</Text>
      </Box>
    </Box>
  );
};

/** The tasks sit behind a thin rail, which costs two columns. */
export const RAIL_TASK_PANEL_GUTTER = 2;

export const RailTaskPanel: FC<TaskPanelProps> = ({ header, children }) => {
  const theme = useTheme();
  return (
    <Box marginBottom={1}>
      <Rail glyph={RAIL_THIN} color={theme.accentAlt}>
        <Text color={theme.textMuted} bold>
          {header}
        </Text>
        {children}
      </Rail>
    </Box>
  );
};
