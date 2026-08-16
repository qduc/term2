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
      <Text color="#fbbf24">
        ⏸ Queue paused: {queueLength} item(s) pending.
        {pauseReason === 'failure' ? ' Last turn failed.' : ''}{' '}
        <Text color="#22c55e" bold>
          [<Text color="#4ade80">R</Text>]esume
        </Text>{' '}
        <Text color="#ef4444" bold>
          [<Text color="#f87171">D</Text>]iscard
        </Text>
      </Text>
    </Box>
  );
};

export default QueuePausedPrompt;
