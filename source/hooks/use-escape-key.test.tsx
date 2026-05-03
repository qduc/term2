import test from 'ava';
import React, { useState } from 'react';
import { render } from 'ink-testing-library';
import { useEscapeKey } from './use-escape-key.js';
import type { InputMode } from '../context/InputContext.js';
import { Box, Text } from 'ink';

const TestComponent = ({ initialValue = 'some text' }) => {
  const [value, onChange] = useState(initialValue);
  const [mode, setMode] = useState<InputMode>('text');
  const escPressedRef = { current: false };
  const [, setCursorOverride] = useState<number | null>(null);

  const { escHintVisible } = useEscapeKey({
    mode,
    setMode,
    value,
    onChange,
    settings: { open: () => {} } as any,
    settingsValue: { settingKey: null, close: () => {} } as any,
    setCursorOverride,
    escPressedRef,
  });

  return (
    <Box flexDirection="column">
      <Text>Value: {value}</Text>
      {escHintVisible && <Text>HINT</Text>}
    </Box>
  );
};

test('pressing ESC once shows hint, second time clears input', async (t) => {
  const { lastFrame, stdin } = render(<TestComponent />);

  // Initial state
  t.true(lastFrame()!.includes('Value: some text'));
  t.false(lastFrame()!.includes('HINT'));

  // First ESC
  // Ink's stdin.write sends raw bytes. ESC is \u001B
  stdin.write('\u001B');

  // Wait for state updates and re-render
  await new Promise((resolve) => setTimeout(resolve, 50));

  t.true(lastFrame()!.includes('HINT'), 'Hint should be visible after first ESC');
  t.true(lastFrame()!.includes('Value: some text'), 'Value should still be there');

  // Second ESC
  stdin.write('\u001B');

  // Wait for state updates and re-render
  await new Promise((resolve) => setTimeout(resolve, 50));

  const finalFrame = lastFrame()!;
  // console.log('Final frame:', JSON.stringify(finalFrame));
  t.false(finalFrame.includes('HINT'), 'Hint should be hidden after second ESC');
  t.true(finalFrame.includes('Value:'), 'Label should be present');
  t.is(finalFrame.trim(), 'Value:', 'Value should be cleared');
});
