import React, { FC, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';

interface LargeUncachedConfirmationPromptProps {
  usage: NormalizedUsage | null | undefined;
  onConfirm: () => void;
  onDecline: () => void;
}

const LargeUncachedConfirmationPrompt: FC<LargeUncachedConfirmationPromptProps> = ({ usage, onConfirm, onDecline }) => {
  const [selectedIndex, setSelectedIndex] = useState(0); // 0 = Send, 1 = Cancel

  useInput((input, key) => {
    if (key.upArrow || key.downArrow) {
      setSelectedIndex((prev) => (prev === 0 ? 1 : 0));
    }

    if (key.return) {
      if (selectedIndex === 0) {
        onConfirm();
      } else {
        onDecline();
      }
      return;
    }

    if (input === 'y') {
      onConfirm();
      return;
    }

    if (input === 'n') {
      onDecline();
      return;
    }

    if (key.escape) {
      onDecline();
    }
  });

  const promptTokens = usage?.prompt_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_tokens;

  return (
    <Box flexDirection="column">
      <Text color="yellow">
        Send {promptTokens.toLocaleString()} tokens anyway?
        {cacheReadTokens != null
          ? ` (\u26A0\uFE0F ${cacheReadTokens.toLocaleString()} uncached)`
          : ' (may miss prompt cache)'}
      </Text>
      <Box flexDirection="column" marginLeft={1}>
        <Text color={selectedIndex === 0 ? 'green' : undefined}>{selectedIndex === 0 ? '❯ ' : '  '}Send</Text>
        <Text color={selectedIndex === 1 ? 'red' : undefined}>{selectedIndex === 1 ? '❯ ' : '  '}Cancel</Text>
      </Box>
    </Box>
  );
};

export default LargeUncachedConfirmationPrompt;
