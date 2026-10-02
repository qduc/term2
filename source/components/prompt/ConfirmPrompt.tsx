import React, { FC, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { GLYPH_WARNING, useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

export interface ConfirmPromptProps {
  question: string;
  /** Consequence the user should weigh before answering; rendered above the question. */
  warning?: string;
  confirmLabel?: string;
  declineLabel?: string;
  /** 0 highlights the confirm option, 1 the decline option. Default to 1 when confirming is destructive. */
  defaultIndex?: 0 | 1;
  onConfirm: () => void;
  onDecline: () => void;
  onCancel: () => void;
}

const HINTS: ReadonlyArray<[key: string, action: string]> = [
  ['↑↓', 'navigate'],
  ['⏎', 'select'],
  ['y/n', 'answer'],
  ['Esc', 'cancel'],
];

/** The single look and key contract for every binary confirmation above the input. */
const ConfirmPrompt: FC<ConfirmPromptProps> = ({
  question,
  warning,
  confirmLabel = 'Yes',
  declineLabel = 'No',
  defaultIndex = 0,
  onConfirm,
  onDecline,
  onCancel,
}) => {
  const theme = useTheme();
  const { MenuFrame } = useSkin();
  const [selectedIndex, setSelectedIndex] = useState<0 | 1>(defaultIndex);

  useInput((input, key) => {
    if (key.upArrow || key.downArrow) {
      setSelectedIndex((previous) => (previous === 0 ? 1 : 0));
      return;
    }
    if (key.return) {
      if (selectedIndex === 0) onConfirm();
      else onDecline();
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
    if (key.escape || input === '\u001B') {
      onCancel();
    }
  });

  const options = [confirmLabel, declineLabel];

  return (
    <MenuFrame borderColor={theme.borderActive} hasItems={false} footerPlacement="outside">
      {warning && (
        <Text color={theme.warning}>
          {GLYPH_WARNING} {warning}
        </Text>
      )}
      <Text bold>{question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((label, index) => {
          const selected = index === selectedIndex;
          return (
            <Box key={label}>
              <SelectionMarker selected={selected} />
              <Text color={selected ? theme.accent : theme.textMuted} bold={selected}>
                {label}
              </Text>
            </Box>
          );
        })}
      </Box>
      <MenuFooter hints={HINTS} />
    </MenuFrame>
  );
};

export default ConfirmPrompt;
