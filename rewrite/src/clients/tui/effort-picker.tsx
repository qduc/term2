import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './presentation/components/theme.js';
import { useInteractionInput, type InteractionInput } from './interaction-input.js';

const LEVELS = [
  ['none', 'No reasoning tokens'],
  ['minimal', 'Use the least reasoning effort'],
  ['low', 'Use low reasoning effort'],
  ['medium', 'Use medium reasoning effort'],
  ['high', 'Use high reasoning effort'],
  ['xhigh', 'Use extra-high reasoning effort'],
  ['default', 'Use the model default'],
] as const;

/** The old terminal's reasoning-effort list: choose a level, or leave without applying one. */
export function EffortPicker({
  current,
  inputHandler,
  onClose,
  onSelect,
}: {
  current: string | undefined;
  inputHandler: InteractionInput;
  onClose(): void;
  onSelect(level: (typeof LEVELS)[number][0]): void;
}): React.ReactElement {
  const theme = useTheme();
  const active = current && LEVELS.some(([level]) => level === current) ? current : 'default';
  const [selected, setSelected] = useState(LEVELS.findIndex(([level]) => level === active));
  const index = Math.min(Math.max(0, selected), LEVELS.length - 1);
  const [, description] = LEVELS[index]!;
  useInteractionInput(inputHandler, (input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setSelected((current) => Math.max(0, current - 1));
    if (key.downArrow) return setSelected((current) => Math.min(LEVELS.length - 1, current + 1));
    if (key.return) return onSelect(LEVELS[index]![0]);
    void input;
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold>Reasoning effort</Text>
      <Text color={theme.textSubtle}>Current: {active}</Text>
      {LEVELS.map(([level], row) => (
        <Text key={level}>
          {row === index ? '❯' : ' '} {level}
          {level === active ? <Text color={theme.success}> (current)</Text> : null}
        </Text>
      ))}
      <Text color={theme.textSubtle}>{description}</Text>
      <Text color={theme.textSubtle}>↑↓ choose · Enter apply · Esc cancel</Text>
    </Box>
  );
}
