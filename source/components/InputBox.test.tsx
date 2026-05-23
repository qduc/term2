import test from 'ava';
import React, { useEffect } from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import InputBox, { calculateInputWidth } from './InputBox.js';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import type { SlashCommand } from '../slash-commands.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
import { registerProvider, unregisterProvider } from '../providers/index.js';
import { clearModelCache } from '../services/model-service.js';

// Mock slash commands
const mockSlashCommands: SlashCommand[] = [
  { name: '/clear', description: 'Clear screen', action: () => {} },
  { name: '/quit', description: 'Quit app', action: () => {} },
];

// Default props for InputBox (only the actual props it accepts)
const defaultProps = {
  onSubmit: () => {},
  slashCommands: mockSlashCommands,
  isShellMode: false,

  settingsService: createMockSettingsService(),
  loggingService: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
  } as any,
  historyService: {
    getMessages: () => [],
    getTurns: () => [],
    addMessage: () => {},
    clear: () => {},
  } as any,
  onHistoryUp: () => {},
  onHistoryDown: () => {},
};

// Helper to wrap InputBox with InputProvider
const TestInputBox = (props: typeof defaultProps) => (
  <InputProvider>
    <InputBox {...props} />
  </InputProvider>
);

const TestInputBoxWithCursorState = (props: typeof defaultProps) => (
  <InputProvider>
    <CursorState />
    <InputBox {...props} />
  </InputProvider>
);

const CursorState = () => {
  const { cursorOffset } = useInputContext();

  return (
    <Box>
      <Text>Cursor:{cursorOffset}</Text>
    </Box>
  );
};

const getCursorFromFrame = (frame: string | undefined): number | null => {
  const match = frame?.match(/Cursor:(\d+)/);
  return match ? Number(match[1]) : null;
};

const waitForCursor = async (lastFrame: () => string | undefined, predicate: (cursor: number | null) => boolean) => {
  for (let i = 0; i < 20; i++) {
    const cursor = getCursorFromFrame(lastFrame());
    if (predicate(cursor)) return cursor;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getCursorFromFrame(lastFrame());
};

test('InputBox renders without crashing', (t) => {
  const { lastFrame } = render(<TestInputBox {...defaultProps} />);
  t.truthy(lastFrame());
});

test('InputBox shows the input prompt', (t) => {
  const { lastFrame } = render(<TestInputBox {...defaultProps} />);
  const output = lastFrame();
  t.truthy(output);
  // Should show the prompt character
  t.true(output!.includes('❯'));
});

test('InputBox shows the shell prompt when in shell mode', (t) => {
  const { lastFrame } = render(<TestInputBox {...defaultProps} isShellMode />);
  const output = lastFrame();
  t.truthy(output);
  t.true(output!.includes('$'));
});

test('InputBox can be submitted', (t) => {
  let submitted = false;
  const onSubmit = () => {
    submitted = true;
  };

  render(<TestInputBox {...defaultProps} onSubmit={onSubmit} />);

  // Note: We can't easily test actual submission in this unit test
  // because it requires user input simulation which is complex with MultilineInput
  // This test just verifies the component renders with the onSubmit prop
  t.false(submitted);
  t.pass();
});

test('InputBox accepts slash commands prop', (t) => {
  const customCommands: SlashCommand[] = [{ name: '/test', description: 'Test command', action: () => {} }];

  const { lastFrame } = render(<TestInputBox {...defaultProps} slashCommands={customCommands} />);

  t.truthy(lastFrame());
  t.pass();
});

test('InputBox accepts history callbacks', (t) => {
  let historyUpCalled = false;
  let historyDownCalled = false;

  const onHistoryUp = () => {
    historyUpCalled = true;
  };

  const onHistoryDown = () => {
    historyDownCalled = true;
  };

  render(<TestInputBox {...defaultProps} onHistoryUp={onHistoryUp} onHistoryDown={onHistoryDown} />);

  // Note: We can't easily trigger history navigation in this unit test
  // This test just verifies the component accepts the callbacks
  t.false(historyUpCalled);
  t.false(historyDownCalled);
  t.pass();
});

test('InputBox keeps cursor fixed when left arrow switches model provider', async (t) => {
  const initialValue = '/model gpt-5';
  const { lastFrame, stdin } = render(
    <TestInputBoxWithCursorState
      {...defaultProps}
      slashCommands={[
        ...mockSlashCommands,
        {
          name: '/model',
          description: 'Select model',
          action: () => {},
          completion: { type: 'model', trigger: '/model ' },
        },
      ]}
    />,
  );

  stdin.write(initialValue);
  const beforeCursor = await waitForCursor(lastFrame, (cursor) => cursor !== null && cursor > 0);
  stdin.write('\u001B[D');
  await new Promise((resolve) => setTimeout(resolve, 50));

  t.is(getCursorFromFrame(lastFrame()), beforeCursor, lastFrame());
});

test('calculateInputWidth uses default prompt width for normal mode', (t) => {
  t.is(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: false, isShellMode: false }), 74);
});

test('calculateInputWidth uses default prompt width for shell mode', (t) => {
  t.is(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: false, isShellMode: true }), 74);
});

test('calculateInputWidth uses rejection prompt width for rejection mode', (t) => {
  t.is(calculateInputWidth({ terminalColumns: 80, waitingForRejectionReason: true, isShellMode: false }), 71);
});

const StateDisplay = () => {
  const { input, mode } = useInputContext();
  return (
    <Text>
      Input:{input}|Mode:{mode}
    </Text>
  );
};

const ModelSelectionSetup = ({ trigger }: { trigger: string }) => {
  const { setInput, setMode, setCursorOffset, setTriggerIndex } = useInputContext();

  useEffect(() => {
    setInput(trigger);
    setCursorOffset(trigger.length);
    setTriggerIndex(trigger.length);
    setMode('model_selection');
  }, [trigger, setInput, setCursorOffset, setTriggerIndex, setMode]);

  return null;
};

test('settings-backed model selection restores settings menu after submit', async (t) => {
  clearModelCache();
  const mockProviderId = `mock-provider-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: mockProviderId,
    label: 'Mock Provider',
    fetchModels: async () => [{ id: 'gpt-test', name: 'GPT Test' }],
  });
  t.teardown(() => {
    clearModelCache();
    unregisterProvider(mockProviderId);
  });

  let submitted = false;
  const onSubmit = () => {
    submitted = true;
  };

  const settingsService = createMockSettingsService({
    'agent.provider': mockProviderId,
  });

  const { stdin, lastFrame } = render(
    <InputProvider>
      <ModelSelectionSetup trigger="/settings agent.model " />
      <StateDisplay />
      <InputBox {...defaultProps} settingsService={settingsService} onSubmit={onSubmit} />
    </InputProvider>,
  );

  // Wait for models to load
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Press Enter to select the model
  stdin.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const frame = lastFrame() ?? '';
  t.false(submitted, 'onSubmit should not be called for settings-backed model selection');
  t.true(frame.includes('Input:/settings '), `Input should be restored to settings trigger, got: ${frame}`);
  t.false(frame.includes('gpt-test'), 'Model ID should not appear in input');
});

test('command-backed model selection still submits after selection', async (t) => {
  clearModelCache();
  const mockProviderId = `mock-provider-2-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: mockProviderId,
    label: 'Mock Provider 2',
    fetchModels: async () => [{ id: 'gpt-test-2', name: 'GPT Test 2' }],
  });
  t.teardown(() => {
    clearModelCache();
    unregisterProvider(mockProviderId);
  });

  let submitted = false;
  const onSubmit = () => {
    submitted = true;
  };

  const settingsService = createMockSettingsService({
    'agent.provider': mockProviderId,
  });

  const { stdin } = render(
    <InputProvider>
      <ModelSelectionSetup trigger="/model " />
      <StateDisplay />
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        onSubmit={onSubmit}
        slashCommands={[
          ...mockSlashCommands,
          {
            name: '/model',
            description: 'Select model',
            action: () => {},
            completion: { type: 'model', trigger: '/model ' },
          },
        ]}
      />
    </InputProvider>,
  );

  // Wait for models to load
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Press Enter to select the model
  stdin.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 50));

  t.true(submitted, 'onSubmit should be called for command-backed model selection');
});

test('settings value completion saves setting and reopens settings menu targeting the saved key', async (t) => {
  const settingsService = createMockSettingsService({
    'shell.timeout': 120000,
  });

  const { stdin, lastFrame } = render(
    <InputProvider>
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[
          ...mockSlashCommands,
          {
            name: '/settings',
            description: 'Change setting',
            action: () => {},
            completion: { type: 'settings', trigger: '/settings ', resetTrigger: '/settings reset ' },
          },
        ]}
      />
      <StateDisplay />
    </InputProvider>,
  );

  // Set input to trigger value completion
  stdin.write('/settings shell.timeout ');

  // Wait until the mode switches to settings_value_completion
  for (let i = 0; i < 20; i++) {
    const frame = lastFrame() ?? '';
    if (frame.includes('Mode:settings_value_completion')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Press Enter to save the value (60000)
  stdin.write('6');
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write('0');
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write('0');
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write('0');
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write('0');
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write('\r');

  // Wait until the mode switches back to settings_completion
  for (let i = 0; i < 20; i++) {
    const frame = lastFrame() ?? '';
    if (frame.includes('Mode:settings_completion')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // The setting should be updated to 60000
  t.is(settingsService.get('shell.timeout'), 60000);

  // The menu should be restored targeting 'shell.timeout'
  const frame = lastFrame() ?? '';
  t.true(frame.includes('Input:/settings'), `Input should be restored to settings trigger, got: ${frame}`);
  t.true(frame.includes('▶ shell.timeout'), `Selection should remain on shell.timeout, got: ${frame}`);
});
