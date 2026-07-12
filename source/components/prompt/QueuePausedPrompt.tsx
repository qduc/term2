import React, { FC } from 'react';
import { Box, Text, useInput } from 'ink';
import type { QueuePauseReason } from '../../services/queue/queue-controller.js';

export interface QueuePausedPromptProps {
  queueLength: number;
  pauseReason?: QueuePauseReason;
  onResume: () => void;
  onDiscard: () => void;
}

const QueuePausedPrompt: FC<QueuePausedPromptProps> = ({ queueLength, pauseReason, onResume, onDiscard }) => {
  useInput((input, key) => {
    if (input === 'r') {
      onResume();
      return;
    }

    if (input === 'd') {
      onDiscard();
      return;
    }

    if (key.escape) {
      onDiscard();
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="yellow">
        Queue paused: {queueLength} item(s) pending.
        {pauseReason === 'failure' ? ' Last turn failed.' : ''} <Text color="green">[R]esume</Text>{' '}
        <Text color="red">[D]iscard</Text>
      </Text>
    </Box>
  );
};

export default QueuePausedPrompt;
