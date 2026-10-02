import React, { FC } from 'react';
import { Box, Text, useInput } from 'ink';
import type { QueuePauseReason } from '../../services/queue/queue-controller.js';
import { MenuFooter } from '../common/MenuContainer.js';
import { GLYPH_WARNING, useTheme } from '../theme.js';

export interface QueuePausedPromptProps {
  queueLength: number;
  pauseReason?: QueuePauseReason;
  onResume: () => void;
  onDiscard: () => void;
}

const QueuePausedPrompt: FC<QueuePausedPromptProps> = ({ queueLength, pauseReason, onResume, onDiscard }) => {
  const theme = useTheme();
  useInput((input, key) => {
    if (input === 'r' || input === 'R') {
      onResume();
      return;
    }

    if (input === 'x' || input === 'X') {
      onDiscard();
      return;
    }

    // Esc must never implicitly discard queued messages.
    if (key.escape) return;
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
      <Text color={theme.warning}>
        {GLYPH_WARNING} Queue paused: {queueLength} {queueLength === 1 ? 'item' : 'items'} pending.
        {pauseReason === 'failure' ? ' Last turn failed.' : ''}
      </Text>
      <MenuFooter
        hints={[
          ['r', 'resume'],
          ['x', 'discard'],
        ]}
      />
    </Box>
  );
};

export default QueuePausedPrompt;
