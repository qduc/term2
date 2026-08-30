import React, { FC } from 'react';
import { Box, Text, useInput } from 'ink';
import type { QueuePauseReason } from '../../services/queue/queue-controller.js';
import { COLOR_DANGER, COLOR_DANGER_SOFT, COLOR_SUCCESS, COLOR_WARNING } from '../theme.js';

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
    <Box flexDirection="column" marginY={1}>
      <Text color={COLOR_WARNING}>
        ⏸ Queue paused: {queueLength} item(s) pending.
        {pauseReason === 'failure' ? ' Last turn failed.' : ''}{' '}
        <Text color={COLOR_SUCCESS} bold>
          [<Text color={COLOR_SUCCESS}>R</Text>]esume
        </Text>{' '}
        <Text color={COLOR_DANGER} bold>
          [<Text color={COLOR_DANGER_SOFT}>D</Text>]iscard
        </Text>
      </Text>
    </Box>
  );
};

export default QueuePausedPrompt;
