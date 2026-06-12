import React, { FC, useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface InputSurgeConfirmationPromptProps {
  reason: string;
  onConfirm: () => void;
  onDecline: () => void;
}

const InputSurgeConfirmationPrompt: FC<InputSurgeConfirmationPromptProps> = ({ reason, onConfirm, onDecline }) => {
  const [selectedIndex, setSelectedIndex] = useState(0); // 0 = Send anyway, 1 = Cancel

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

  return (
    <Box flexDirection="column">
      <Text color="yellow">⚠️ Input Surge Warning: {reason}</Text>
      <Text color="yellow">Send request anyway?</Text>
      <Box flexDirection="column" marginLeft={1}>
        <Text color={selectedIndex === 0 ? 'green' : undefined}>{selectedIndex === 0 ? '❯ ' : '  '}Send anyway</Text>
        <Text color={selectedIndex === 1 ? 'red' : undefined}>{selectedIndex === 1 ? '❯ ' : '  '}Cancel</Text>
      </Box>
    </Box>
  );
};

export default InputSurgeConfirmationPrompt;
