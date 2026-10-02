import React, { FC } from 'react';
import { Text, useInput } from 'ink';
import type { QueuePauseReason } from '../../services/queue/queue-controller.js';
import { MenuFooter } from '../common/MenuContainer.js';
import { GLYPH_WARNING, useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

export interface QueuePausedPromptProps {
  queueLength: number;
  pauseReason?: QueuePauseReason;
  onResume: () => void;
  onDiscard: () => void;
}

const QueuePausedPrompt: FC<QueuePausedPromptProps> = ({ queueLength, pauseReason, onResume, onDiscard }) => {
  const theme = useTheme();
  const { MenuFrame } = useSkin();
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
    <MenuFrame borderColor={theme.borderActive} hasItems={false} footerPlacement="outside">
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
    </MenuFrame>
  );
};

export default QueuePausedPrompt;
