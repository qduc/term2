// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act, useEffect, useState } from 'react';
import { useEscapeKey } from './use-escape-key.js';
import type { InputMode } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/input/triggers.js';
import { Box, Text, useInput, useStdin } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';

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
    providerSelection: { goBack: () => {} } as any,
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
  const result = await renderInAct(element);
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

it.sequential('pressing ESC once shows hint, second time clears input', async () => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;

  const TestHarness = () => {
    useCaptureInputEmitter((emitter) => {
      inputEmitter = emitter;
    });
    return <TestComponent />;
  };

  const { lastFrame } = await renderAndFlush(<TestHarness />);

  // Initial state
  expect(lastFrame()!.includes('Value: some text')).toBe(true);
  expect(lastFrame()!.includes('HINT')).toBe(false);

  // First ESC
  // Ink's stdin.write sends raw bytes. ESC is \u001B
  await pressEscape(inputEmitter!);

  expect(lastFrame()!.includes('HINT'), 'Hint should be visible after first ESC').toBe(true);
  expect(lastFrame()!.includes('Value: some text'), 'Value should still be there').toBe(true);

  // Second ESC
  await pressEscape(inputEmitter!);

  const finalFrame = lastFrame()!;
  // console.log('Final frame:', JSON.stringify(finalFrame));
  expect(finalFrame.includes('HINT'), 'Hint should be hidden after second ESC').toBe(false);
  expect(finalFrame.includes('Mode: text'), 'Mode should still be text').toBe(true);
  expect(finalFrame.includes('Value:'), 'Label should be present').toBe(true);
  expect(finalFrame.includes('some text'), 'Value should be cleared').toBe(false);
});

it.sequential('useInput fires ESC in non-text mode', async () => {
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
  expect(inputFired, 'useInput should fire on ESC').toBe(true);
});

it.sequential('pressing ESC in model_selection mode clears input and switches to text mode', async () => {
  const modes: InputMode[] = [];
  const values: string[] = [];
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
  expect(initialFrame.includes('Mode: model_selection'), 'Initial mode should be model_selection').toBe(true);
  expect(initialFrame.includes('Value: /model'), 'Initial value should contain trigger').toBe(true);

  // Press ESC
  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  expect(frame.includes('Mode: text'), 'Mode should switch to text').toBe(true);
  expect(frame.includes('/model'), 'Input trigger text should be cleared').toBe(false);
});

it.sequential('pressing ESC in slash_commands mode clears input and switches to text mode', async () => {
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

  expect(lastFrame()!.includes('Mode: slash_commands'), 'Initial mode should be slash_commands').toBe(true);

  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  expect(frame.includes('Mode: text'), 'Mode should switch to text').toBe(true);
  expect(frame.includes('/cle'), 'Input trigger text should be cleared').toBe(false);
});

it.sequential('pressing ESC in skill_selection mode keeps input and switches to text mode', async () => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  const SkillSelectionTestComponent = () => {
    const [value, onChange] = useState('/skills ');
    const [mode, setMode] = useState<InputMode>('skill_selection');
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

  const { lastFrame } = await renderAndFlush(<SkillSelectionTestComponent />);

  expect(lastFrame()!.includes('Mode: skill_selection'), 'Initial mode should be skill_selection').toBe(true);

  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  expect(frame.includes('Mode: text'), 'Mode should switch to text').toBe(true);
  expect(frame.includes('/skills'), 'Skill trigger text should remain').toBe(true);
});

it.sequential('pressing ESC in path_completion mode keeps input and switches to text mode', async () => {
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

  expect(lastFrame()!.includes('Mode: path_completion'), 'Initial mode should be path_completion').toBe(true);

  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  expect(frame.includes('Mode: text'), 'Mode should switch to text').toBe(true);
  expect(
    frame.includes('Value: @src/foo'),
    'Inline path trigger text must be preserved when cancelling the popup',
  ).toBe(true);
});

it.sequential('pressing ESC in settings_completion mode clears input and switches to text mode', async () => {
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

  expect(lastFrame()!.includes('Mode: settings_completion'), 'Initial mode should be settings_completion').toBe(true);

  await pressEscape(inputEmitter!);

  const frame = lastFrame()!;
  expect(frame.includes('Mode: text'), 'Mode should switch to text').toBe(true);
  expect(frame.includes('/settings'), 'Input trigger text should be cleared').toBe(false);
});

it.sequential(
  'pressing ESC in model_selection mode with settings-backed model setting restores settings menu',
  async () => {
    let settingsOpenArgs: { startIndex: number; initialSelectionKey: string } | null = null;
    let modelsClosed = false;
    const cursorOverrides: (number | null)[] = [];
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
        providerSelection: { goBack: () => {} } as any,
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
    expect(initialFrame.includes('Mode: model_selection'), 'Initial mode should be model_selection').toBe(true);
    expect(initialFrame.includes('Value: /settings agent.model'), 'Initial value should contain settings trigger').toBe(
      true,
    );

    // Press ESC
    await pressEscape(inputEmitter!);

    const frame = lastFrame()!;

    // Should NOT switch to text mode - should keep settings_completion or similar
    expect(frame.includes('Mode: text'), 'Mode should not switch to text for settings-backed model').toBe(false);

    // Should close models menu
    expect(modelsClosed, 'Models menu should be closed').toBe(true);

    // Should call settings.open with the model key
    const hasArgs = settingsOpenArgs !== null;
    expect(hasArgs, 'settings.open should have been called').toBe(true);
    if (hasArgs) {
      // settingsOpenArgs is narrowed to non-null here by TypeScript
      expect(settingsOpenArgs!.initialSelectionKey).toBe('agent.model'); // was: t.is(settingsOpenArgs!.initialSelectionKey, 'agent.model', 'Settings should open with agent.model key')
      expect(settingsOpenArgs!.startIndex).toBe(SETTINGS_TRIGGER.length); // was: t.is(settingsOpenArgs!.startIndex, SETTINGS_TRIGGER.length, 'Settings should open at trigger length')
    }
  },
);

it.sequential(
  'pressing ESC in non-settings settings_value_completion mode keeps trigger text and switches to text mode',
  async () => {
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
        providerSelection: { goBack: () => {} } as any,
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

    expect(lastFrame()!).toContain('Mode: settings_value_completion');

    await pressEscape(inputEmitter!);

    const frame = lastFrame()!;
    expect(frame.includes('Mode: text'), 'Mode should switch to text').toBe(true);
    expect(frame).toContain('Value: /effort');
  },
);

it.sequential('pressing ESC in provider_selection calls goBack', async () => {
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  let goBackCalls = 0;

  const ProviderSelectionTestComponent = () => {
    const [value, onChange] = useState('');
    const [mode, setMode] = useState<InputMode>('provider_selection');
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
      providerSelection: { goBack: () => goBackCalls++ } as any,
      setCursorOverride,
      dismissedCompletionRef,
      inputRevisionRef,
    });

    return (
      <Box flexDirection="column">
        <Text>Mode: {mode}</Text>
      </Box>
    );
  };

  const { lastFrame } = await renderAndFlush(<ProviderSelectionTestComponent />);
  expect(lastFrame()!.includes('Mode: provider_selection')).toBe(true);

  await pressEscape(inputEmitter!);

  expect(goBackCalls).toBe(1);
  expect(lastFrame()!.includes('Mode: provider_selection')).toBe(true);
});

it.sequential(
  'pressing ESC in provider_selection calls the LATEST goBack function (verifying ref is not stale)',
  async () => {
    let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
    let lastGoBackCalledWith: number | null = null;
    let triggerUpdate: (() => void) | null = null;

    const ProviderSelectionStaleClosureHarness = () => {
      const [value, onChange] = useState('');
      const [mode, setMode] = useState<InputMode>('provider_selection');
      const [version, setVersion] = useState(1);
      const dismissedCompletionRef = { current: null } as any;
      const inputRevisionRef = { current: 0 };
      const [, setCursorOverride] = useState<number | null>(null);

      triggerUpdate = () => setVersion((v) => v + 1);

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
        providerSelection: {
          goBack: () => {
            lastGoBackCalledWith = version;
          },
        },
        setCursorOverride,
        dismissedCompletionRef,
        inputRevisionRef,
      });

      return (
        <Box flexDirection="column">
          <Text>Mode: {mode}</Text>
          <Text>Version: {version}</Text>
        </Box>
      );
    };

    const { lastFrame } = await renderAndFlush(<ProviderSelectionStaleClosureHarness />);
    expect(lastFrame()!.includes('Mode: provider_selection')).toBe(true);
    expect(lastFrame()!.includes('Version: 1')).toBe(true);

    // Trigger re-render to change providerSelection identity and implementation
    await act(async () => {
      triggerUpdate!();
    });
    await flushReactUpdates(5);

    expect(lastFrame()!.includes('Version: 2')).toBe(true);

    // Press ESC
    await pressEscape(inputEmitter!);

    expect(lastGoBackCalledWith as any).toBe(2);
  },
);
