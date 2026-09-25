import React, { FC, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MenuFooter } from '../common/MenuContainer.js';
import {
  COLOR_ACCENT,
  COLOR_BORDER_ACTIVE,
  COLOR_TEXT_MUTED,
  COLOR_WARNING,
  GLYPH_SELECTED,
  GLYPH_WARNING,
} from '../theme.js';

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
  ['esc', 'cancel'],
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
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} paddingX={1}>
      {warning && (
        <Text color={COLOR_WARNING}>
          {GLYPH_WARNING} {warning}
        </Text>
      )}
      <Text bold>{question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((label, index) => {
          const selected = index === selectedIndex;
          return (
            <Text key={label} color={selected ? COLOR_ACCENT : COLOR_TEXT_MUTED} bold={selected}>
              {selected ? `${GLYPH_SELECTED} ` : '  '}
              {label}
            </Text>
          );
        })}
      </Box>
      <MenuFooter hints={HINTS} />
    </Box>
  );
};

export default ConfirmPrompt;
