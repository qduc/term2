import React, { FC, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { COLOR_DANGER, COLOR_SUCCESS } from '../theme.js';

interface HandoffConfirmationPromptProps {
  onConfirm: () => void;
  onDecline: () => void;
  onCancel: () => void;
}

const HandoffConfirmationPrompt: FC<HandoffConfirmationPromptProps> = ({ onConfirm, onDecline, onCancel }) => {
  const [selectedIndex, setSelectedIndex] = useState(0); // 0 = Yes, 1 = No

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
    }

    if (input === 'y') {
      onConfirm();
    }

    if (input === 'n') {
      onDecline();
    }

    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>📋 Change model?</Text>
      <Box flexDirection="column" marginLeft={1}>
        <Text color={selectedIndex === 0 ? COLOR_SUCCESS : undefined}>{selectedIndex === 0 ? '❯ ' : '  '}Yes</Text>
        <Text color={selectedIndex === 1 ? COLOR_DANGER : undefined}>{selectedIndex === 1 ? '❯ ' : '  '}No</Text>
      </Box>
    </Box>
  );
};

export default HandoffConfirmationPrompt;
