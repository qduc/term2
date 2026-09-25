import React, { FC } from 'react';
import { Box, Text, useInput } from 'ink';
import type { QueuePauseReason } from '../../services/queue/queue-controller.js';
import { MenuFooter } from '../common/MenuContainer.js';
import { COLOR_BORDER_ACTIVE, COLOR_WARNING, GLYPH_WARNING } from '../theme.js';

export interface QueuePausedPromptProps {
  queueLength: number;
  pauseReason?: QueuePauseReason;
  onResume: () => void;
  onDiscard: () => void;
}

const QueuePausedPrompt: FC<QueuePausedPromptProps> = ({ queueLength, pauseReason, onResume, onDiscard }) => {
  useInput((input, key) => {
    if (input === 'r' || input === 'R') {
      onResume();
      return;
    }

    if (input === 'd' || input === 'D') {
      onDiscard();
      return;
    }

    if (key.escape) {
      onDiscard();
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} paddingX={1}>
      <Text color={COLOR_WARNING}>
        {GLYPH_WARNING} Queue paused: {queueLength} item(s) pending.
        {pauseReason === 'failure' ? ' Last turn failed.' : ''}
      </Text>
      <MenuFooter
        hints={[
          ['r', 'resume'],
          ['d', 'discard'],
          ['esc', 'discard'],
        ]}
      />
    </Box>
  );
};

export default QueuePausedPrompt;
