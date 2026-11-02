import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { ShellActivityProps, TaskPanelProps } from '../types.js';
import { Card } from './card.js';

/** `❯ command` on a quiet surface, like the input it echoes. */
export const CardsShellActivity: FC<ShellActivityProps> = ({ command }) => {
  const theme = useTheme();
  return (
    <Box>
      <Box flexShrink={0} marginRight={1}>
        <Text color={theme.danger} bold>
          !
        </Text>
      </Box>
      <Box flexShrink={1}>
        <Text color={theme.textSubtle}>
          running <Text bold>{command}</Text>
        </Text>
      </Box>
    </Box>
  );
};

/** Border and padding either side of a card. */
export const CARDS_TASK_PANEL_GUTTER = 4;

export const CardsTaskPanel: FC<TaskPanelProps> = ({ header, children }) => {
  const theme = useTheme();
  return (
    <Box marginBottom={1} flexDirection="column">
      <Card
        color={theme.accentAlt}
        title={
          <Text color={theme.accentAlt} bold>
            {header}
          </Text>
        }
      >
        {children}
      </Card>
    </Box>
  );
};
