// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act, useEffect, useState } from 'react';
import { render } from 'ink-testing-library';
import { useEscapeKey } from './use-escape-key.js';
import type { InputMode } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/Input/triggers.js';
import { Box, Text, useInput, useStdin } from 'ink';

const TestComponent = ({ initialValue = 'some text', initialMode = 'text' as InputMode }) => {
  const [value, onChange] = useState(initialValue);
  const [mode, setMode] = useState<InputMode>(initialMode);
  const dismissedCompletionRef = { current: null } as any;
  const inputRevisionRef = { current: 0 };
  const [, setCursorOverride] = useState<number | null>(null);

  const { escHintVisible } = useEscapeKey({
    mode,
    setMode,
    value,
    onChange,
    settings: { open: () => {} } as any,
    settingsValue: { settingKey: null, close: () => {} } as any,
    setCursorOverride,
    dismissedCompletionRef,
    inputRevisionRef,
  });

  return (
    <Box flexDirection="column">
      <Text>Mode: {mode}</Text>
      <Text>Value: {value}</Text>
      {escHintVisible && <Text>HINT</Text>}
    </Box>
  );
};

const flushReactUpdates = async (iterations = 1) => {
  await act(async () => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

const renderAndFlush = async (element: React.ReactElement) => {
  const result = render(element);
  await flushReactUpdates(10);
  return result;
};

const useCaptureInputEmitter = (setEmitter: (emitter: any) => void) => {
  const stdin = useStdin() as any;

  useEffect(() => {
    setEmitter(stdin.internal_eventEmitter);
  }, [setEmitter, stdin]);
};

const pressEscape = async (emitter: { emit: (event: string, input: string) => void }) => {
  await act(async () => {
    emitter.emit('input', '\u001B');
  });

  await flushReactUpdates(3);
};

test('pressing ESC once shows hint, second time clears input', async (t) => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;

  const TestHarness = () => {
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });
    return <TestComponent />;
  };

  const { lastFrame } = await renderAndFlush(<TestHarness />);

  // Initial state
  t.true(lastFrame()!.includes('Value: some text'));
  t.false(lastFrame()!.includes('HINT'));

  // First ESC
  // Ink's stdin.write sends raw bytes. ESC is \u001B
  await pressEscape(inputEmitter!);

  t.true(lastFrame()!.includes('HINT'), 'Hint should be visible after first ESC');
  t.true(lastFrame()!.includes('Value: some text'), 'Value should still be there');

  // Second ESC
  await pressEscape(inputEmitter!);

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
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  const MinimalComponent = () => {
    useInput((_input, key) => {
      if (key.escape) inputFired = true;
    });
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });
    return <Text>test</Text>;
  };

  await renderAndFlush(<MinimalComponent />);
  await pressEscape(inputEmitter!);
  t.true(inputFired, 'useInput should fire on ESC');
});

test('pressing ESC in model_selection mode clears input and switches to text mode', async (t) => {
  let modes: InputMode[] = [];
  let values: string[] = [];
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;

  const ModelSelectionTestComponent = () => {
    const [value, onChange] = useState('/model ');
    const [mode, setMode] = useState<InputMode>('model_selection');
    const dismissedCompletionRef = { current: null } as any;
    const inputRevisionRef = { current: 0 };
    const [, setCursorOverride] = useState<number | null>(null);

    modes.push(mode);
    values.push(value);
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });

    useEscapeKey({
      mode,
      setMode,
      value,
      onChange,
      settings: { open: () => {} } as any,
      settingsValue: { settingKey: null, close: () => {} } as any,
      setCursorOverride,
      dismissedCompletionRef,
      inputRevisionRef,
    });

    return (
      <Box flexDirection="column">
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame } = await renderAndFlush(<ModelSelectionTestComponent />);

  const initialFrame = lastFrame()!;
  t.log('Initial frame:', JSON.stringify(initialFrame));
  t.log('Initial modes:', modes.join(', '));
  t.log('Initial values:', values.join(', '));
  t.true(initialFrame.includes('Mode: model_selection'), 'Initial mode should be model_selection');
  t.true(initialFrame.includes('Value: /model'), 'Initial value should contain trigger');

  // Press ESC
  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  t.log('Modes seen:', modes.join(', '));
  t.log('Values seen:', values.join(', '));
  t.log('Frame after ESC:', frame);
  t.true(frame.includes('Mode: text'), 'Mode should switch to text');
  t.false(frame.includes('/model'), 'Input trigger text should be cleared');
});

test('pressing ESC in slash_commands mode clears input and switches to text mode', async (t) => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  const SlashTestComponent = () => {
    const [value, onChange] = useState('/cle');
    const [mode, setMode] = useState<InputMode>('slash_commands');
    const dismissedCompletionRef = { current: null } as any;
    const inputRevisionRef = { current: 0 };
    const [, setCursorOverride] = useState<number | null>(null);
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });

    useEscapeKey({
      mode,
      setMode,
      value,
      onChange,
      settings: { open: () => {} } as any,
      settingsValue: { settingKey: null, close: () => {} } as any,
      setCursorOverride,
      dismissedCompletionRef,
      inputRevisionRef,
    });

    return (
      <Box flexDirection="column">
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame } = await renderAndFlush(<SlashTestComponent />);

  t.true(lastFrame()!.includes('Mode: slash_commands'), 'Initial mode should be slash_commands');

  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  t.true(frame.includes('Mode: text'), 'Mode should switch to text');
  t.false(frame.includes('/cle'), 'Input trigger text should be cleared');
});

test('pressing ESC in path_completion mode keeps input and switches to text mode', async (t) => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  const PathTestComponent = () => {
    const [value, onChange] = useState('@src/foo');
    const [mode, setMode] = useState<InputMode>('path_completion');
    const dismissedCompletionRef = { current: null } as any;
    const inputRevisionRef = { current: 0 };
    const [, setCursorOverride] = useState<number | null>(null);
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });

    useEscapeKey({
      mode,
      setMode,
      value,
      onChange,
      settings: { open: () => {} } as any,
      settingsValue: { settingKey: null, close: () => {} } as any,
      setCursorOverride,
      dismissedCompletionRef,
      inputRevisionRef,
    });

    return (
      <Box flexDirection="column">
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame } = await renderAndFlush(<PathTestComponent />);

  t.true(lastFrame()!.includes('Mode: path_completion'), 'Initial mode should be path_completion');

  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  t.true(frame.includes('Mode: text'), 'Mode should switch to text');
  t.true(frame.includes('Value: @src/foo'), 'Inline path trigger text must be preserved when cancelling the popup');
});

test('pressing ESC in settings_completion mode clears input and switches to text mode', async (t) => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  const SettingsTestComponent = () => {
    const [value, onChange] = useState('/settings ');
    const [mode, setMode] = useState<InputMode>('settings_completion');
    const dismissedCompletionRef = { current: null } as any;
    const inputRevisionRef = { current: 0 };
    const [, setCursorOverride] = useState<number | null>(null);
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });

    useEscapeKey({
      mode,
      setMode,
      value,
      onChange,
      settings: { open: () => {} } as any,
      settingsValue: { settingKey: null, close: () => {} } as any,
      setCursorOverride,
      dismissedCompletionRef,
      inputRevisionRef,
    });

    return (
      <Box flexDirection="column">
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame } = await renderAndFlush(<SettingsTestComponent />);

  t.true(lastFrame()!.includes('Mode: settings_completion'), 'Initial mode should be settings_completion');

  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  t.true(frame.includes('Mode: text'), 'Mode should switch to text');
  t.false(frame.includes('/settings'), 'Input trigger text should be cleared');
});

test('pressing ESC in model_selection mode with settings-backed model setting restores settings menu', async (t) => {
  let settingsOpenArgs: { startIndex: number; initialSelectionKey: string } | null = null;
  let modelsClosed = false;
  let cursorOverrides: (number | null)[] = [];
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;

  const SettingsBackedModelComponent = () => {
    const [value, onChange] = useState('/settings agent.model ');
    const [mode, setMode] = useState<InputMode>('model_selection');
    const dismissedCompletionRef = { current: null } as any;
    const inputRevisionRef = { current: 0 };
    const [cursorOverride, setCursorOverride] = useState<number | null>(null);

    cursorOverrides.push(cursorOverride);
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });

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
      dismissedCompletionRef,
      inputRevisionRef,
    });

    return (
      <Box flexDirection="column">
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame } = await renderAndFlush(<SettingsBackedModelComponent />);

  const initialFrame = lastFrame()!;
  t.true(initialFrame.includes('Mode: model_selection'), 'Initial mode should be model_selection');
  t.true(initialFrame.includes('Value: /settings agent.model'), 'Initial value should contain settings trigger');

  // Press ESC
  await pressEscape(inputEmitter!);

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

test('pressing ESC in non-settings settings_value_completion mode keeps trigger text and switches to text mode', async (t) => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  const SettingsValueTestComponent = () => {
    const [value, onChange] = useState('/effort ');
    const [mode, setMode] = useState<InputMode>('settings_value_completion');
    const dismissedCompletionRef = { current: null } as any;
    const inputRevisionRef = { current: 0 };
    const [, setCursorOverride] = useState<number | null>(null);
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });

    useEscapeKey({
      mode,
      setMode,
      value,
      onChange,
      settings: { open: () => {} } as any,
      // settingKey is null because this completion was opened from a non-/settings command
      settingsValue: { settingKey: null, close: () => {} } as any,
      setCursorOverride,
      dismissedCompletionRef,
      inputRevisionRef,
    });

    return (
      <Box flexDirection="column">
        <Text>Mode: {mode}</Text>
        <Text>Value: {value}</Text>
      </Box>
    );
  };

  const { lastFrame } = await renderAndFlush(<SettingsValueTestComponent />);

  t.true(lastFrame()!.includes('Mode: settings_value_completion'), 'Initial mode should be settings_value_completion');

  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  t.true(frame.includes('Mode: text'), 'Mode should switch to text');
  t.true(
    frame.includes('Value: /effort'),
    'Inline settings-value trigger text must be preserved when cancelling the popup',
  );
});
