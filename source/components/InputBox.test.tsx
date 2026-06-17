// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import React, { useEffect, useRef, act } from 'react';
import { Box, Text } from 'ink';
import InputBox, { getProviderWizardPromptLabel } from './InputBox.js';
import ModelSelectionMenu from './menu/ModelSelectionMenu.js';
import SettingsSelectionMenu from './menu/SettingsSelectionMenu.js';
import { computeModelInsertion } from './input/insertions.js';
import { SETTINGS_TRIGGER } from './input/triggers.js';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import type { SlashCommand } from '../slash-commands.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { LoggingService } from '../services/logging/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import { registerProvider, unregisterProvider } from '../providers/index.js';
import { clearModelCache } from '../services/model-service.js';
import { useModelSelection } from '../hooks/use-model-selection.js';
import { useSettingsCompletion } from '../hooks/use-settings-completion.js';
import { renderInAct, toVisibleText } from '../test-helpers/ink-testing.js';

// Mock slash commands
const mockSlashCommands: SlashCommand[] = [
  { name: '/clear', description: 'Clear screen', action: () => {} },
  { name: '/quit', description: 'Quit app', action: () => {} },
];

// Types for test props — mock services only need to satisfy the subset used by InputBox
type TestProps = {
  onSubmit: (v: any) => void;
  slashCommands: SlashCommand[];
  isShellMode?: boolean;
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  waitingForRejectionReason?: boolean;
  allowEmptySubmit?: boolean;
  promptLabel?: string;
  onSystemMessage?: (text: string) => void;
  providersMenuRef?: React.MutableRefObject<{ open: () => void } | null>;
};

const createMockLoggingService = (): LoggingService =>
  ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
  } as unknown as LoggingService);

const createMockHistoryService = (): HistoryService =>
  ({
    getMessages: () => [],
    getTurns: () => [],
    addMessage: () => {},
    clear: () => {},
  } as unknown as HistoryService);

// Default props for InputBox
const defaultProps = {
  onSubmit: () => {},
  slashCommands: mockSlashCommands,
  isShellMode: false,
  settingsService: createMockSettingsService(),
  loggingService: createMockLoggingService(),
  historyService: createMockHistoryService(),
};

// Helper to wrap InputBox with InputProvider
const TestInputBox = (props: TestProps) => (
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

/**
 * Poll `lastFrame()` until `predicate` returns true, or the timeout elapses.
 * Replaces arbitrary `act` / `setImmediate` iteration loops with a deterministic wait.
 */
const waitFor = async (
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  { timeoutMs = 2000, intervalMs = 10 } = {},
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let frame = lastFrame() ?? '';
  while (!predicate(frame)) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms. Last frame:\n${frame}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    });
    frame = lastFrame() ?? '';
  }
  return frame;
};

/**
 * Poll an arbitrary getter until `predicate` returns true, or the timeout elapses.
 * Use for non-frame conditions (e.g., settings values, callback invocation flags).
 */
const waitForCondition = async <T,>(
  getter: () => T,
  predicate: (value: T) => boolean,
  { timeoutMs = 3000, intervalMs = 10 } = {},
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let value = getter();
  while (!predicate(value)) {
    if (Date.now() > deadline) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms. Last value: ${JSON.stringify(value)}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    });
    value = getter();
  }
  return value;
};

const flushReactUpdates = async (iterations = 5) => {
  await act(async () => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

const renderAndFlush = async (element: React.ReactElement, context: Parameters<typeof renderInAct>[1]) => {
  const result = await renderInAct(element, context);
  await flushReactUpdates(10);
  return result;
};

/** Write input to stdin and flush pending updates for Ink to process it. */
const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  await act(async () => {
    stdin.write(input);
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

it.sequential('InputBox shows the input prompt', async () => {
  const { lastFrame } = await renderAndFlush(<TestInputBox {...defaultProps} />);
  const output = lastFrame();
  // Should show the prompt character
  expect(output!.includes('❯')).toBe(true);
});

it.sequential('InputBox shows the shell prompt when in shell mode', async () => {
  const { lastFrame } = await renderAndFlush(<TestInputBox {...defaultProps} isShellMode />);
  const output = lastFrame();
  expect(output).toBeTruthy();
  expect(output!.includes('$')).toBe(true);
});

it.sequential('getProviderWizardPromptLabel maps provider wizard phases to prompt labels', () => {
  expect(getProviderWizardPromptLabel('wizard_name')).toBe('Enter Provider Name: ');
  expect(getProviderWizardPromptLabel('wizard_url')).toBe('Enter Base API URL: ');
  expect(getProviderWizardPromptLabel('wizard_key')).toBe('Enter API Key: ');
  expect(getProviderWizardPromptLabel('list' as any)).toBe(undefined);
});

it.sequential('InputBox renders the provided prompt label', async () => {
  const { lastFrame } = await renderAndFlush(<TestInputBox {...defaultProps} promptLabel="Enter Provider Name: " />);
  const output = lastFrame();
  expect(output).toBeTruthy();
  expect(output!.includes('Enter Provider Name:')).toBe(true);
});

it.sequential('InputBox onSubmit is not called on empty input when allowEmptySubmit is false', async () => {
  let submitted = false;
  const onSubmit = () => {
    submitted = true;
  };

  const { stdin } = await renderAndFlush(
    <TestInputBox {...defaultProps} onSubmit={onSubmit} allowEmptySubmit={false} />,
  );

  await writeInput(stdin, '\r');

  expect(submitted).toBe(false);
});

it.sequential('InputBox onSubmit is called on empty input when allowEmptySubmit is true', async () => {
  let submitted = false;
  let submittedTurn: any = null;
  const onSubmit = (turn: any) => {
    submitted = true;
    submittedTurn = turn;
  };

  const { stdin } = await renderAndFlush(
    <TestInputBox {...defaultProps} onSubmit={onSubmit} allowEmptySubmit={true} />,
  );

  await writeInput(stdin, '\r');

  expect(submitted).toBe(true);
  expect(submittedTurn).toEqual({ text: '' });
});

it.sequential('InputBox keeps cursor fixed when left arrow switches model provider', async () => {
  const initialValue = '/model gpt-5';
  const { lastFrame, stdin } = await renderAndFlush(
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
  const beforeCursor = getCursorFromFrame(lastFrame());
  await writeInput(stdin, '\u001B[D');

  expect(getCursorFromFrame(lastFrame()), lastFrame()).toBe(beforeCursor);
});

const StateDisplay = () => {
  const { input, mode } = useInputContext();
  return (
    <Text>
      Input:{input}|Mode:{mode}
    </Text>
  );
};

const noopLoggingService = createMockLoggingService();

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

it.sequential('settings-backed model selection restores settings menu after submit', async () => {
  clearModelCache();
  const mockProviderId = `mock-provider-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: mockProviderId,
    label: 'Mock Provider',
    fetchModels: async () => [{ id: 'gpt-test', name: 'GPT Test' }],
  });

  const settingsService = createMockSettingsService({
    'agent.provider': mockProviderId,
  });

  const { lastFrame } = await renderAndFlush(
    <InputProvider>
      <ModelSelectionSubmitHarness
        trigger="/settings agent.model "
        settingsService={settingsService}
        onSubmit={() => {}}
      />
    </InputProvider>,
  );

  const frame = await waitFor(lastFrame, (f) => f.includes('agent.model'));
  const visibleFrame = toVisibleText(frame);

  expect(settingsService.get('agent.model')).toBe('gpt-test');
  expect(settingsService.get('agent.provider')).toBe(mockProviderId);
  expect(visibleFrame.includes('Input:/settings ')).toBe(true);
  expect(visibleFrame.includes('▶ agent.model')).toBe(true);

  // Cleanup after test
  clearModelCache();
  unregisterProvider(mockProviderId);
});

it.sequential('command-backed model selection still submits after selection', async () => {
  clearModelCache();
  const mockProviderId = `mock-provider-2-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: mockProviderId,
    label: 'Mock Provider 2',
    fetchModels: async () => [{ id: 'gpt-test-2', name: 'GPT Test 2' }],
  });

  let submitted = false;
  const settingsService = createMockSettingsService({
    'agent.provider': mockProviderId,
  });

  await renderAndFlush(
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

  await waitForCondition(
    () => submitted,
    (v) => v,
  );

  expect(submitted).toBe(true);
  expect(settingsService.get('agent.provider')).toBe(mockProviderId);

  // Cleanup after test
  clearModelCache();
  unregisterProvider(mockProviderId);
});

it.sequential('settings value completion saves setting and reopens settings menu targeting the saved key', async () => {
  const settingsService = createMockSettingsService({
    'shell.timeout': 120000,
  });

  const { lastFrame } = await renderAndFlush(
    <InputProvider>
      <SettingsValueCommitHarness settingsService={settingsService} reset={false} />
    </InputProvider>,
  );

  const frame = await waitFor(lastFrame, (f) => f.includes('shell.timeout'));
  const visibleFrame = toVisibleText(frame);

  // The setting should be updated to 60000
  expect(settingsService.get('shell.timeout')).toBe(60000);

  // The menu should be restored targeting 'shell.timeout'
  expect(visibleFrame.includes('Input:/settings')).toBe(true);
  expect(visibleFrame.includes('▶ shell.timeout')).toBe(true);
});

it.sequential(
  'settings value completion resets setting and reopens settings menu targeting the reset key',
  async () => {
    const settingsService = createMockSettingsService({
      'shell.timeout': 60000,
    });

    const { lastFrame } = await renderAndFlush(
      <InputProvider>
        <SettingsValueCommitHarness settingsService={settingsService} reset={true} />
      </InputProvider>,
    );

    const frame = await waitFor(lastFrame, (f) => f.includes('shell.timeout'));
    const visibleFrame = toVisibleText(frame);

    // The setting should be reset to default (120000)
    expect(settingsService.get('shell.timeout')).toBe(120000);

    // The menu should be restored targeting 'shell.timeout'
    expect(visibleFrame.includes('Input:/settings')).toBe(true);
    expect(visibleFrame.includes('▶ shell.timeout')).toBe(true);
  },
);

it.sequential(
  'settings value completion prefers typed custom numeric value over the selected current value',
  async () => {
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

    const { stdin } = await renderAndFlush(
      <InputProvider>
        <InputBox
          {...defaultProps}
          settingsService={settingsService}
          slashCommands={[...mockSlashCommands, mockSettingsCommand]}
        />
      </InputProvider>,
    );

    await writeInput(stdin, '/settings shell.timeout 60000');
    await writeInput(stdin, '\r');

    await waitForCondition(
      () => settingsService.get('shell.timeout'),
      (v) => v === 60000,
    );

    expect(settingsService.get('shell.timeout')).toBe(60000);
  },
);

it.sequential('settings value completion persists startup-only settings for the next session', async () => {
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

  const { stdin } = await renderAndFlush(
    <InputProvider>
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, mockSettingsCommand]}
      />
    </InputProvider>,
  );

  await writeInput(stdin, '/settings agent.maxTurns 30');
  await writeInput(stdin, '\r');

  await waitForCondition(
    () => settingsService.get('agent.maxTurns'),
    (v) => v === 30,
  );

  expect(settingsService.get('agent.maxTurns')).toBe(30);
});

it.sequential('settings value completion shows restart notice for startup-only settings', async () => {
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

  const { stdin } = await renderAndFlush(
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

  await writeInput(stdin, '/settings agent.maxTurns 30');
  await writeInput(stdin, '\r');

  await waitForCondition(
    () => systemMessages,
    (msgs) => msgs.length > 0,
  );

  expect(systemMessages).toEqual(['Saved agent.maxTurns = 30. This setting applies after restart.']);
});

it.sequential('InputBox ignores focus sequences when not in text mode', async () => {
  const TestHarness = () => (
    <InputProvider>
      <StateDisplay />
      <InputBox {...defaultProps} />
    </InputProvider>
  );

  const { lastFrame, stdin } = await renderAndFlush(<TestHarness />);

  // Trigger slash commands mode by writing "/"
  await writeInput(stdin, '/');
  let frame = await waitFor(lastFrame, (f) => f.includes('slash_commands'));
  expect(frame.includes('Input:/|Mode:slash_commands')).toBe(true);

  // Write focus-in sequence — should be ignored
  await writeInput(stdin, '\x1b[I');
  await flushReactUpdates(10);
  frame = lastFrame() ?? '';
  expect(frame.includes('Input:/|Mode:slash_commands')).toBe(true);

  // Write focus-out sequence — should be ignored
  await writeInput(stdin, '\x1b[O');
  await flushReactUpdates(10);
  frame = lastFrame() ?? '';
  // Input should still be "/"
  expect(frame.includes('Input:/|Mode:slash_commands')).toBe(true);
});

it.sequential('InputBox ignores focus sequences when in text mode', async () => {
  const TestHarness = () => (
    <InputProvider>
      <StateDisplay />
      <InputBox {...defaultProps} />
    </InputProvider>
  );

  const { lastFrame, stdin } = await renderAndFlush(<TestHarness />);
  let frame = lastFrame() ?? '';
  expect(frame.includes('Input:|Mode:text')).toBe(true);

  // Write focus-in sequence — should be ignored
  await writeInput(stdin, '\x1b[I');
  await flushReactUpdates(10);
  frame = lastFrame() ?? '';
  // Input should still be empty
  expect(frame.includes('Input:|Mode:text')).toBe(true);

  // Write focus-out sequence — should be ignored
  await writeInput(stdin, '\x1b[O');
  await flushReactUpdates(10);
  frame = lastFrame() ?? '';
  // Input should still be empty
  expect(frame.includes('Input:|Mode:text')).toBe(true);
});

it.sequential('settings value completion shows current custom settings value in suggestions list', async () => {
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 80;

  // Cleanup after test
  process.stdout.columns = originalColumns;

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

  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider>
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, mockSettingsCommand]}
      />
    </InputProvider>,
  );

  // Write trigger value to enter settings value completion mode
  await writeInput(stdin, '/settings agent.maxTurns ');
  const frame = await waitFor(lastFrame, (f) => f.includes('Current value'), { timeoutMs: 5000 });
  const visibleFrame = toVisibleText(frame);

  expect(visibleFrame.includes('35 — Current value')).toBe(true);
});

it.sequential('InputBox allows backspace and delete keys to modify input in provider wizard phases', async () => {
  const providersMenuRef = { current: null as any };
  const settingsService = createMockSettingsService();

  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider>
      <StateDisplay />
      <InputBox {...defaultProps} settingsService={settingsService} providersMenuRef={providersMenuRef} />
    </InputProvider>,
  );

  const pressKey = async (keyStr: string) => {
    await act(async () => {
      stdin.write(keyStr);
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
  };

  // Open the providers menu
  await act(async () => {
    providersMenuRef.current.open();
  });
  await flushReactUpdates(10);

  // Navigate up to "Add Custom Provider" (wrapping to the second-to-last item) and press Enter
  await pressKey('\u001B[A'); // Up Arrow (wraps to Reorder Providers)
  await pressKey('\u001B[A'); // Up Arrow (moves to Add Custom Provider)
  await pressKey('\r'); // Enter

  let frame = await waitFor(lastFrame, (f) => f.includes('provider_selection'));
  expect(frame.includes('Mode:provider_selection')).toBe(true);
  expect(frame.includes('Step 1: Provider Name')).toBe(true);

  // Type character 'a'
  await pressKey('a');
  frame = lastFrame() ?? '';
  expect(frame.includes('Input:a')).toBe(true);

  // Press Backspace (\x7f)
  await pressKey('\x7f');
  frame = lastFrame() ?? '';
  expect(frame.includes('Input:|')).toBe(true);

  // Type character 'b'
  await pressKey('b');
  frame = lastFrame() ?? '';
  expect(frame.includes('Input:b')).toBe(true);

  // Move cursor left (\u001B[D) and press Delete (\u001B[3~)
  await pressKey('\u001B[D'); // Left arrow
  await pressKey('\u001B[3~'); // Delete
  frame = lastFrame() ?? '';
  expect(frame.includes('Input:|')).toBe(true);
});
