import test from 'ava';
import React, { useEffect, useRef, act } from 'react';
import { render } from 'ink-testing-library';
import { Box, Text, useStdin } from 'ink';
import InputBox, { calculateInputWidth, getProviderWizardPromptLabel } from './InputBox.js';
import ModelSelectionMenu from './ModelSelectionMenu.js';
import SettingsSelectionMenu from './SettingsSelectionMenu.js';
import { computeModelInsertion } from './Input/insertions.js';
import { SETTINGS_TRIGGER } from './Input/triggers.js';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import type { SlashCommand } from '../slash-commands.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
import { registerProvider, unregisterProvider } from '../providers/index.js';
import { clearModelCache } from '../services/model-service.js';
import { useModelSelection } from '../hooks/use-model-selection.js';
import { useSettingsCompletion } from '../hooks/use-settings-completion.js';

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
const TestInputBox = (props: any) => (
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

const flushReactUpdates = async (iterations = 1) => {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  stdin.write(input);
  await flushReactUpdates(2);
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

test('getProviderWizardPromptLabel maps provider wizard phases to prompt labels', (t) => {
  t.is(getProviderWizardPromptLabel('wizard_name'), 'Enter Provider Name: ');
  t.is(getProviderWizardPromptLabel('wizard_url'), 'Enter Base API URL: ');
  t.is(getProviderWizardPromptLabel('wizard_key'), 'Enter API Key: ');
  t.is(getProviderWizardPromptLabel('list' as any), undefined);
});

test('InputBox renders the provided prompt label', (t) => {
  const { lastFrame } = render(<TestInputBox {...defaultProps} promptLabel="Enter Provider Name: " />);
  const output = lastFrame();
  t.truthy(output);
  t.true(output!.includes('Enter Provider Name:'));
});

test('InputBox onSubmit is not called on empty input when allowEmptySubmit is false', async (t) => {
  let submitted = false;
  const onSubmit = () => {
    submitted = true;
  };

  const { stdin } = render(<TestInputBox {...defaultProps} onSubmit={onSubmit} allowEmptySubmit={false} />);

  await writeInput(stdin, '\r');
  await flushReactUpdates(5);

  t.false(submitted);
});

test('InputBox onSubmit is called on empty input when allowEmptySubmit is true', async (t) => {
  let submitted = false;
  let submittedTurn: any = null;
  const onSubmit = (turn: any) => {
    submitted = true;
    submittedTurn = turn;
  };

  const { stdin } = render(<TestInputBox {...defaultProps} onSubmit={onSubmit} allowEmptySubmit={true} />);

  await writeInput(stdin, '\r');
  await flushReactUpdates(5);

  t.true(submitted);
  t.deepEqual(submittedTurn, { text: '' });
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

  await writeInput(stdin, initialValue);
  await flushReactUpdates(20);
  const beforeCursor = getCursorFromFrame(lastFrame());
  await writeInput(stdin, '\u001B[D');
  await flushReactUpdates(5);

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

const noopLoggingService = defaultProps.loggingService;

const ModelSelectionSubmitHarness = ({
  trigger,
  settingsService,
  onSubmit,
}: {
  trigger: string;
  settingsService: ReturnType<typeof createMockSettingsService>;
  onSubmit?: (value: string) => void;
}) => {
  const { setInput, setMode, setCursorOffset, setTriggerIndex, input, mode } = useInputContext();
  const settings = useSettingsCompletion(settingsService);
  const models = useModelSelection({
    loggingService: noopLoggingService,
    settingsService,
  });
  const didCommitRef = useRef(false);

  useEffect(() => {
    setInput(trigger);
    setCursorOffset(trigger.length);
    setTriggerIndex(trigger.length);
    setMode('model_selection');
  }, [trigger, setCursorOffset, setInput, setMode, setTriggerIndex]);

  useEffect(() => {
    if (didCommitRef.current) return;
    const selected = models.getSelectedItem();
    if (!selected) return;
    didCommitRef.current = true;

    const insertion = computeModelInsertion({
      selection: selected,
      triggerIndex: models.triggerIndex,
      provider: models.provider,
      value: input,
      appendTrailingSpace: false,
    });
    if (!insertion) return;

    if (models.modelSettingConfig) {
      const { modelKey, providerKey } = models.modelSettingConfig;
      settingsService.set(modelKey, selected.id);
      if (models.provider) {
        settingsService.set(providerKey, models.provider);
      }
      setInput(SETTINGS_TRIGGER);
      setCursorOffset(SETTINGS_TRIGGER.length);
      setTriggerIndex(SETTINGS_TRIGGER.length);
      setMode('settings_completion');
      settings.open(SETTINGS_TRIGGER.length, modelKey);
      return;
    }

    onSubmit?.(insertion.nextValue);
  }, [input, models, onSubmit, setCursorOffset, setInput, setMode, setTriggerIndex, settings, settingsService]);

  if (mode === 'settings_completion') {
    return (
      <>
        <StateDisplay />
        <SettingsSelectionMenu
          items={settings.filteredEntries}
          selectedIndex={settings.selectedIndex}
          scrollOffset={settings.scrollOffset}
          query={settings.query}
          activeCategoryId={settings.activeCategoryId}
          categories={settings.categories}
        />
      </>
    );
  }

  return (
    <>
      <StateDisplay />
      <ModelSelectionMenu
        settingsService={settingsService}
        items={models.filteredModels}
        selectedIndex={models.selectedIndex}
        query={models.query}
        provider={models.provider}
        loading={models.loading}
        error={models.error}
        scrollOffset={models.scrollOffset}
        canSwitchProvider={models.canSwitchProvider}
      />
    </>
  );
};

const SettingsValueCommitHarness = ({
  settingsService,
  reset,
}: {
  settingsService: ReturnType<typeof createMockSettingsService>;
  reset: boolean;
}) => {
  const { setInput, setMode, setCursorOffset, setTriggerIndex } = useInputContext();
  const settings = useSettingsCompletion(settingsService);
  const didCommitRef = useRef(false);
  const trigger = '/settings shell.timeout ';
  const restoredInput = `${SETTINGS_TRIGGER}`;

  useEffect(() => {
    setInput(trigger);
    setCursorOffset(trigger.length);
    setTriggerIndex(SETTINGS_TRIGGER.length);
    setMode('settings_value_completion');
  }, [setCursorOffset, setInput, setMode, setTriggerIndex]);

  useEffect(() => {
    if (didCommitRef.current || settings.isOpen) return;
    didCommitRef.current = true;
    if (reset) {
      settingsService.reset('shell.timeout');
    } else {
      settingsService.set('shell.timeout', 60000);
    }
    setInput(restoredInput);
    setCursorOffset(restoredInput.length);
    setTriggerIndex(SETTINGS_TRIGGER.length);
    setMode('settings_completion');
    settings.open(SETTINGS_TRIGGER.length, 'shell.timeout');
  }, [reset, restoredInput, setCursorOffset, setInput, setMode, setTriggerIndex, settings, settingsService]);

  return (
    <>
      <StateDisplay />
      <SettingsSelectionMenu
        items={settings.filteredEntries}
        selectedIndex={settings.selectedIndex}
        scrollOffset={settings.scrollOffset}
        query={settings.query}
        activeCategoryId={settings.activeCategoryId}
        categories={settings.categories}
      />
    </>
  );
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

  const settingsService = createMockSettingsService({
    'agent.provider': mockProviderId,
  });

  const { lastFrame } = render(
    <InputProvider>
      <ModelSelectionSubmitHarness
        trigger="/settings agent.model "
        settingsService={settingsService}
        onSubmit={() => {}}
      />
    </InputProvider>,
  );

  await flushReactUpdates(40);

  const frame = lastFrame() ?? '';
  t.is(settingsService.get('agent.model'), 'gpt-test');
  t.is(settingsService.get('agent.provider'), mockProviderId);
  t.true(frame.includes('Input:/settings '), `Input should be restored to settings trigger, got: ${frame}`);
  t.true(frame.includes('▶ agent.model'), `Selection should target agent.model, got: ${frame}`);
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
  const settingsService = createMockSettingsService({
    'agent.provider': mockProviderId,
  });

  render(
    <InputProvider>
      <ModelSelectionSubmitHarness
        trigger="/model "
        settingsService={settingsService}
        onSubmit={() => {
          submitted = true;
        }}
      />
    </InputProvider>,
  );

  await flushReactUpdates(40);

  t.true(submitted, 'onSubmit should be called for command-backed model selection');
  t.is(settingsService.get('agent.provider'), mockProviderId);
});

test('settings value completion saves setting and reopens settings menu targeting the saved key', async (t) => {
  const settingsService = createMockSettingsService({
    'shell.timeout': 120000,
  });

  const { lastFrame } = render(
    <InputProvider>
      <SettingsValueCommitHarness settingsService={settingsService} reset={false} />
    </InputProvider>,
  );

  await flushReactUpdates(40);

  // The setting should be updated to 60000
  t.is(settingsService.get('shell.timeout'), 60000);

  // The menu should be restored targeting 'shell.timeout'
  const frame = lastFrame() ?? '';
  t.true(frame.includes('Input:/settings'), `Input should be restored to settings trigger, got: ${frame}`);
  t.true(frame.includes('▶ shell.timeout'), `Selection should remain on shell.timeout, got: ${frame}`);
});

test('settings value completion resets setting and reopens settings menu targeting the reset key', async (t) => {
  const settingsService = createMockSettingsService({
    'shell.timeout': 60000,
  });

  const { lastFrame } = render(
    <InputProvider>
      <SettingsValueCommitHarness settingsService={settingsService} reset={true} />
    </InputProvider>,
  );

  await flushReactUpdates(40);

  // The setting should be reset to default (120000)
  t.is(settingsService.get('shell.timeout'), 120000);

  // The menu should be restored targeting 'shell.timeout'
  const frame = lastFrame() ?? '';
  t.true(frame.includes('Input:/settings'), `Input should be restored to settings trigger, got: ${frame}`);
  t.true(frame.includes('▶ shell.timeout'), `Selection should remain on shell.timeout, got: ${frame}`);
});

test('settings value completion prefers typed custom numeric value over the selected current value', async (t) => {
  const settingsService = createMockSettingsService({
    'shell.timeout': 120000,
  });

  const mockSettingsCommand: SlashCommand = {
    name: '/settings',
    description: 'Settings',
    action: () => {},
    completion: {
      type: 'settings',
      trigger: '/settings ',
      resetTrigger: '/settings reset ',
    },
  };

  const { stdin } = render(
    <InputProvider>
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, mockSettingsCommand]}
      />
    </InputProvider>,
  );

  await flushReactUpdates(5);
  await writeInput(stdin, '/settings shell.timeout 60000');
  await flushReactUpdates(30);
  await writeInput(stdin, '\r');
  await flushReactUpdates(40);

  t.is(settingsService.get('shell.timeout'), 60000);
});

test('settings value completion persists startup-only settings for the next session', async (t) => {
  const settingsService = createMockSettingsService({
    'agent.maxTurns': 100,
  });

  const mockSettingsCommand: SlashCommand = {
    name: '/settings',
    description: 'Settings',
    action: () => {},
    completion: {
      type: 'settings',
      trigger: '/settings ',
      resetTrigger: '/settings reset ',
    },
  };

  const { stdin } = render(
    <InputProvider>
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, mockSettingsCommand]}
      />
    </InputProvider>,
  );

  await flushReactUpdates(5);
  await writeInput(stdin, '/settings agent.maxTurns 30');
  await flushReactUpdates(30);
  await writeInput(stdin, '\r');
  await flushReactUpdates(40);

  t.is(settingsService.get('agent.maxTurns'), 30);
});

test('settings value completion shows restart notice for startup-only settings', async (t) => {
  const settingsService = createMockSettingsService({
    'agent.maxTurns': 100,
  });
  const systemMessages: string[] = [];

  const mockSettingsCommand: SlashCommand = {
    name: '/settings',
    description: 'Settings',
    action: () => {},
    completion: {
      type: 'settings',
      trigger: '/settings ',
      resetTrigger: '/settings reset ',
    },
  };

  const { stdin } = render(
    <InputProvider>
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, mockSettingsCommand]}
        onSystemMessage={(text) => {
          systemMessages.push(text);
        }}
      />
    </InputProvider>,
  );

  await flushReactUpdates(5);
  await writeInput(stdin, '/settings agent.maxTurns 30');
  await flushReactUpdates(30);
  await writeInput(stdin, '\r');
  await flushReactUpdates(40);

  t.deepEqual(systemMessages, ['Saved agent.maxTurns = 30. This setting applies after restart.']);
});

test('InputBox ignores focus sequences when not in text mode', async (t) => {
  const TestHarness = () => (
    <InputProvider>
      <StateDisplay />
      <InputBox {...defaultProps} />
    </InputProvider>
  );

  const { lastFrame, stdin } = render(<TestHarness />);

  // Trigger slash commands mode by writing "/"
  await writeInput(stdin, '/');
  await flushReactUpdates(45);

  let frame = lastFrame() ?? '';
  t.true(frame.includes('Input:/|Mode:slash_commands'), frame);

  // Write focus-in sequence
  await writeInput(stdin, '\x1b[I');
  await flushReactUpdates(30);

  frame = lastFrame() ?? '';
  // Input should still be "/"
  t.true(frame.includes('Input:/|Mode:slash_commands'), frame);

  // Write focus-out sequence
  await writeInput(stdin, '\x1b[O');
  await flushReactUpdates(30);

  frame = lastFrame() ?? '';
  // Input should still be "/"
  t.true(frame.includes('Input:/|Mode:slash_commands'), frame);
});

test('InputBox ignores focus sequences when in text mode', async (t) => {
  const TestHarness = () => (
    <InputProvider>
      <StateDisplay />
      <InputBox {...defaultProps} />
    </InputProvider>
  );

  const { lastFrame, stdin } = render(<TestHarness />);
  await flushReactUpdates(5);

  let frame = lastFrame() ?? '';
  t.true(frame.includes('Input:|Mode:text'), frame);

  // Write focus-in sequence
  await writeInput(stdin, '\x1b[I');
  await flushReactUpdates(20);

  frame = lastFrame() ?? '';
  // Input should still be empty
  t.true(frame.includes('Input:|Mode:text'), frame);

  // Write focus-out sequence
  await writeInput(stdin, '\x1b[O');
  await flushReactUpdates(20);

  frame = lastFrame() ?? '';
  // Input should still be empty
  t.true(frame.includes('Input:|Mode:text'), frame);
});

test('settings value completion shows current custom settings value in suggestions list', async (t) => {
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 80;
  t.teardown(() => {
    process.stdout.columns = originalColumns;
  });

  const settingsService = createMockSettingsService({
    'agent.maxTurns': 35,
  });

  const mockSettingsCommand: SlashCommand = {
    name: '/settings',
    description: 'Settings',
    action: () => {},
    completion: {
      type: 'settings',
      trigger: '/settings ',
      resetTrigger: '/settings reset ',
    },
  };

  const { lastFrame, stdin } = render(
    <InputProvider>
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, mockSettingsCommand]}
      />
    </InputProvider>,
  );

  await flushReactUpdates(5);

  // Write trigger value to enter settings value completion mode
  await writeInput(stdin, '/settings agent.maxTurns ');
  await flushReactUpdates(45);

  const frame = lastFrame() ?? '';
  t.true(frame.includes('35 — Current value'), `Should show current custom value in completion list, got:\n${frame}`);
});

const TestInputBoxWithEmitter = ({ onEmitter, ...props }: any) => {
  const stdin = useStdin() as any;
  useEffect(() => {
    if (stdin?.internal_eventEmitter) {
      onEmitter(stdin.internal_eventEmitter);
    }
  }, [stdin, onEmitter]);
  return <InputBox {...props} />;
};

test('InputBox allows backspace and delete keys to modify input in provider wizard phases', async (t) => {
  const providersMenuRef = { current: null as any };
  const settingsService = createMockSettingsService();
  let inputEmitter: any = null;

  const { lastFrame } = render(
    <InputProvider>
      <StateDisplay />
      <TestInputBoxWithEmitter
        {...defaultProps}
        settingsService={settingsService}
        providersMenuRef={providersMenuRef}
        onEmitter={(emitter: any) => {
          inputEmitter = emitter;
        }}
      />
    </InputProvider>,
  );

  await flushReactUpdates(10);

  const pressKey = async (keyStr: string) => {
    await act(async () => {
      inputEmitter.emit('input', keyStr);
    });
    await flushReactUpdates(10);
  };

  // Open the providers menu
  await act(async () => {
    providersMenuRef.current.open();
  });
  await flushReactUpdates(10);

  // Navigate up to "Add Custom Provider" (wrapping to the last item) and press Enter
  await pressKey('\u001B[A'); // Up Arrow
  await pressKey('\r'); // Enter

  let frame = lastFrame() ?? '';
  t.true(frame.includes('Mode:provider_selection'), `Mode should be provider_selection, got:\n${frame}`);
  t.true(frame.includes('Step 1: Provider Name'), `Phase should be wizard_name, got:\n${frame}`);

  // Type character 'a'
  await pressKey('a');
  frame = lastFrame() ?? '';
  t.true(frame.includes('Input:a'), `Input should contain 'a', got:\n${frame}`);

  // Press Backspace (\x7f)
  await pressKey('\x7f');
  frame = lastFrame() ?? '';
  t.true(frame.includes('Input:|'), `Input should be empty after backspace, got:\n${frame}`);

  // Type character 'b'
  await pressKey('b');
  frame = lastFrame() ?? '';
  t.true(frame.includes('Input:b'), `Input should contain 'b', got:\n${frame}`);

  // Move cursor left (\u001B[D) and press Delete (\u001B[3~)
  await pressKey('\u001B[D'); // Left arrow
  await pressKey('\u001B[3~'); // Delete
  frame = lastFrame() ?? '';
  t.true(frame.includes('Input:|'), `Input should be empty after delete, got:\n${frame}`);
});
