import test from 'ava';
import React, { useState } from 'react';
import { render } from 'ink-testing-library';
import { useEscapeKey } from './use-escape-key.js';
import type { InputMode } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/Input/triggers.js';
import { Box, Text, useInput } from 'ink';

const TestComponent = ({ initialValue = 'some text', initialMode = 'text' as InputMode }) => {
  const [value, onChange] = useState(initialValue);
  const [mode, setMode] = useState<InputMode>(initialMode);
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
      <Text>Mode: {mode}</Text>
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
  t.true(finalFrame.includes('Mode: text'), 'Mode should still be text');
  t.true(finalFrame.includes('Value:'), 'Label should be present');
  t.false(finalFrame.includes('some text'), 'Value should be cleared');
});

test('useInput fires ESC in non-text mode', async (t) => {
  // Minimal test: verify useInput fires ESC when mode starts as model_selection
  let inputFired = false;
  const MinimalComponent = () => {
    useInput((_input, key) => {
      if (key.escape) inputFired = true;
    });
    return <Text>test</Text>;
  };

  const { stdin } = render(<MinimalComponent />);
  stdin.write('\u001B');
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.true(inputFired, 'useInput should fire on ESC');
});

test('pressing ESC in model_selection mode clears input and switches to text mode', async (t) => {
  let modes: InputMode[] = [];
  let values: string[] = [];

  const ModelSelectionTestComponent = () => {
    const [value, onChange] = useState('/model ');
    const [mode, setMode] = useState<InputMode>('model_selection');
    const escPressedRef = { current: false };
    const [, setCursorOverride] = useState<number | null>(null);

    modes.push(mode);
    values.push(value);

    useEscapeKey({
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
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame, stdin } = render(<ModelSelectionTestComponent />);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const initialFrame = lastFrame()!;
  t.log('Initial frame:', JSON.stringify(initialFrame));
  t.log('Initial modes:', modes.join(', '));
  t.log('Initial values:', values.join(', '));
  t.true(initialFrame.includes('Mode: model_selection'), 'Initial mode should be model_selection');
  t.true(initialFrame.includes('Value: /model'), 'Initial value should contain trigger');

  // Press ESC
  stdin.write('\u001B');
  await new Promise((resolve) => setTimeout(resolve, 100));

  const frame = lastFrame()!;
  t.log('Modes seen:', modes.join(', '));
  t.log('Values seen:', values.join(', '));
  t.log('Frame after ESC:', frame);
  t.true(frame.includes('Mode: text'), 'Mode should switch to text');
  t.false(frame.includes('/model'), 'Input trigger text should be cleared');
});

test('pressing ESC in slash_commands mode clears input and switches to text mode', async (t) => {
  const SlashTestComponent = () => {
    const [value, onChange] = useState('/cle');
    const [mode, setMode] = useState<InputMode>('slash_commands');
    const escPressedRef = { current: false };
    const [, setCursorOverride] = useState<number | null>(null);

    useEscapeKey({
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
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame, stdin } = render(<SlashTestComponent />);
  await new Promise((resolve) => setTimeout(resolve, 50));

  t.true(lastFrame()!.includes('Mode: slash_commands'), 'Initial mode should be slash_commands');

  stdin.write('\u001B');
  await new Promise((resolve) => setTimeout(resolve, 100));

  const frame = lastFrame()!;
  t.true(frame.includes('Mode: text'), 'Mode should switch to text');
  t.false(frame.includes('/cle'), 'Input trigger text should be cleared');
});

test('pressing ESC in path_completion mode clears input and switches to text mode', async (t) => {
  const PathTestComponent = () => {
    const [value, onChange] = useState('@src/foo');
    const [mode, setMode] = useState<InputMode>('path_completion');
    const escPressedRef = { current: false };
    const [, setCursorOverride] = useState<number | null>(null);

    useEscapeKey({
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
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame, stdin } = render(<PathTestComponent />);
  await new Promise((resolve) => setTimeout(resolve, 50));

  t.true(lastFrame()!.includes('Mode: path_completion'), 'Initial mode should be path_completion');

  stdin.write('\u001B');
  await new Promise((resolve) => setTimeout(resolve, 100));

  const frame = lastFrame()!;
  t.true(frame.includes('Mode: text'), 'Mode should switch to text');
  t.false(frame.includes('@src/foo'), 'Input trigger text should be cleared');
});

test('pressing ESC in settings_completion mode clears input and switches to text mode', async (t) => {
  const SettingsTestComponent = () => {
    const [value, onChange] = useState('/settings ');
    const [mode, setMode] = useState<InputMode>('settings_completion');
    const escPressedRef = { current: false };
    const [, setCursorOverride] = useState<number | null>(null);

    useEscapeKey({
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
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame, stdin } = render(<SettingsTestComponent />);
  await new Promise((resolve) => setTimeout(resolve, 50));

  t.true(lastFrame()!.includes('Mode: settings_completion'), 'Initial mode should be settings_completion');

  stdin.write('\u001B');
  await new Promise((resolve) => setTimeout(resolve, 100));

  const frame = lastFrame()!;
  t.true(frame.includes('Mode: text'), 'Mode should switch to text');
  t.false(frame.includes('/settings'), 'Input trigger text should be cleared');
});

test('pressing ESC in model_selection mode with settings-backed model setting restores settings menu', async (t) => {
  let settingsOpenArgs: { startIndex: number; initialSelectionKey: string } | null = null;
  let modelsClosed = false;
  let cursorOverrides: (number | null)[] = [];

  const SettingsBackedModelComponent = () => {
    const [value, onChange] = useState('/settings agent.model ');
    const [mode, setMode] = useState<InputMode>('model_selection');
    const escPressedRef = { current: false };
    const [cursorOverride, setCursorOverride] = useState<number | null>(null);

    cursorOverrides.push(cursorOverride);

    const mockModels = {
      modelSettingConfig: { modelKey: 'agent.model' },
      close: () => {
        modelsClosed = true;
      },
    };

    useEscapeKey({
      mode,
      setMode,
      value,
      onChange,
      settings: {
        open: (startIndex: number, initialSelectionKey?: string) => {
          settingsOpenArgs = { startIndex, initialSelectionKey: initialSelectionKey || '' };
        },
      } as any,
      settingsValue: { settingKey: null, close: () => {} } as any,
      models: mockModels,
      setCursorOverride,
      escPressedRef,
    });

    return (
      <Box flexDirection="column">
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame, stdin } = render(<SettingsBackedModelComponent />);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const initialFrame = lastFrame()!;
  t.true(initialFrame.includes('Mode: model_selection'), 'Initial mode should be model_selection');
  t.true(initialFrame.includes('Value: /settings agent.model'), 'Initial value should contain settings trigger');

  // Press ESC
  stdin.write('\u001B');
  await new Promise((resolve) => setTimeout(resolve, 100));

  const frame = lastFrame()!;
  t.log('Frame after ESC:', frame);
  t.log('Settings open args:', settingsOpenArgs);
  t.log('Models closed:', modelsClosed);

  // Should NOT switch to text mode - should keep settings_completion or similar
  t.false(frame.includes('Mode: text'), 'Mode should not switch to text for settings-backed model');

  // Should close models menu
  t.true(modelsClosed, 'Models menu should be closed');

  // Should call settings.open with the model key
  const hasArgs = settingsOpenArgs !== null;
  t.true(hasArgs, 'settings.open should have been called');
  if (hasArgs) {
    // settingsOpenArgs is narrowed to non-null here by TypeScript
    t.is(settingsOpenArgs!.initialSelectionKey, 'agent.model', 'Settings should open with agent.model key');
    t.is(settingsOpenArgs!.startIndex, SETTINGS_TRIGGER.length, 'Settings should open at trigger length');
  }
});
