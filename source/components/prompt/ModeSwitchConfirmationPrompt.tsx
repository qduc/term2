import React, { FC, useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ModeSwitchConfirmationPromptProps {
  modeLabel: string;
  targetValue?: boolean;
  onConfirm: () => void;
  onDecline: () => void;
  onCancel?: () => void;
}

const ModeSwitchConfirmationPrompt: FC<ModeSwitchConfirmationPromptProps> = ({
  modeLabel,
  targetValue = true,
  onConfirm,
  onDecline,
  onCancel = onDecline,
}) => {
  // Default to 1 ('No') for safety so pressing Enter doesn't accidentally clear session
  const [selectedIndex, setSelectedIndex] = useState(1);

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

    if (input === 'y' || input === 'Y') {
      onConfirm();
      return;
    }

    if (input === 'n' || input === 'N') {
      onDecline();
      return;
    }

    if (key.escape || input === '\u001B' || input === '\u001b') {
      onCancel();
    }
  });

  const actionText = targetValue ? `switch to ${modeLabel} mode` : `disable ${modeLabel} mode`;

  return (
    <Box flexDirection="column">
      <Text color="yellow">
        ⚠️ {targetValue ? `Switching to ${modeLabel} mode` : `Disabling ${modeLabel} mode`} requires clearing the
        current session.
      </Text>
      <Text>Clear session and {actionText}?</Text>
      <Box flexDirection="column" marginLeft={1}>
        <Text color={selectedIndex === 0 ? 'green' : undefined}>{selectedIndex === 0 ? '❯ ' : '  '}Yes</Text>
        <Text color={selectedIndex === 1 ? 'red' : undefined}>{selectedIndex === 1 ? '❯ ' : '  '}No</Text>
      </Box>
    </Box>
  );
};

export default ModeSwitchConfirmationPrompt;
