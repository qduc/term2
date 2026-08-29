// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect, vi } from 'vitest';
import React, { useEffect, useRef, act } from 'react';
import { Box, Text } from 'ink';
import ApplicationInputSurface from './input/ApplicationInputSurface.js';
import { getProviderWizardPromptLabel } from './input/ProviderMenuSession.js';
import ModelSelectionMenu from './menu/ModelSelectionMenu.js';
import SettingsSelectionMenu from './menu/SettingsSelectionMenu.js';
import { computeModelInsertion } from './input/insertions.js';
import { SETTINGS_TRIGGER } from './input/triggers.js';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { MenuControllerImpl } from './input/menu-controller.js';
import { handleSettingsIntent } from './input/settings-intent-host.js';
import { tryExecuteSlashCommand } from '../utils/slash-command-dispatch.js';
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
import type { UserTurn } from '../types/user-turn.js';
import type { SubmissionMutation } from '../services/conversation/conversation-adapter.js';

const InputBox = ApplicationInputSurface;

vi.mock('../services/file-service.js', () => ({
  getWorkspaceEntries: vi.fn(async () => [{ path: 'mock/path', type: 'file' }]),
  refreshWorkspaceEntries: vi.fn(async () => [{ path: 'mock/path', type: 'file' }]),
  getWorkspaceEntriesMeta: vi.fn(() => ({
    lastLoadedAt: null,
    totalEntries: 1,
    truncated: false,
    truncatedByTotalLimit: false,
    limit: 10_000,
  })),
}));

// Mock slash commands
const mockSlashCommands: SlashCommand[] = [
  { name: '/clear', description: 'Clear screen', action: () => {} },
  { name: '/quit', description: 'Quit app', action: () => {} },
];

// Types for test props — mock services only need to satisfy the subset used by InputBox
type TestProps = {
  onSubmit: (v: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) => void;
  slashCommands: SlashCommand[];
  isShellMode?: boolean;
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  turnInFlight?: boolean;
  waitingForRejectionReason?: boolean;
  allowEmptySubmit?: boolean;
  promptLabel?: string;
  onSystemMessage?: (text: string) => void;
  pendingQueuedMessages?: ReadonlyArray<{
    id: string;
    text: string;
    delivery: 'steer' | 'follow_up';
    queuedAt: number;
  }>;
  onRetractQueuedMessage?: (id: string) => Promise<SubmissionMutation>;
  onEditQueuedMessage?: (id: string, turn: UserTurn) => Promise<SubmissionMutation>;
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

// Graph 3 (settings / settings-value-child / settings-model) applies its
// setting changes through a correlated apply-settings/reset-setting intent,
// handled by the application effect host — not by InputBox itself. Tests
// that exercise that end-to-end flow need a controller wired to the same
// handler app.tsx uses, mirroring the real composition root.
const createSettingsBackedController = (
  settingsService: SettingsService,
  opts?: { onSystemMessage?: (text: string) => void },
) => {
  const controller = new MenuControllerImpl();
  controller.setIntentHost(({ intentRequest }) =>
    handleSettingsIntent(intentRequest, {
      settingsService,
      onSettingChange: () => {},
      onSystemMessage: opts?.onSystemMessage,
    }),
  );
  return controller;
};

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

const renderAndFlush = async (element: React.ReactElement, context?: Parameters<typeof renderInAct>[1]) => {
  const result = await renderInAct(element, context);
  await flushReactUpdates(2);
  return result;
};

/** Write input to stdin and flush pending updates for Ink to process it. */
const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  await act(async () => {
    stdin.write(input);
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

it.sequential('InputBox shows the input prompt and idle shortcut hints', async () => {
  const { lastFrame } = await renderAndFlush(<TestInputBox {...defaultProps} />);
  const output = lastFrame();
  // Should show the prompt character
  expect(output!.includes('❯')).toBe(true);
  expect(output!.includes('Ctrl+O model · Ctrl+T effort')).toBe(true);
});

it.sequential('up enters the queued selector at the bottom item and edit submits by id', async () => {
  const edits: Array<{ id: string; turn: UserTurn }> = [];
  const { lastFrame, stdin } = await renderAndFlush(
    <TestInputBox
      {...defaultProps}
      pendingQueuedMessages={[
        { id: 'q-1', text: 'first queued', delivery: 'follow_up', queuedAt: 1 },
        { id: 'q-2', text: 'second queued', delivery: 'follow_up', queuedAt: 2 },
      ]}
      onEditQueuedMessage={async (id, turn) => {
        edits.push({ id, turn });
        return { kind: 'applied', stage: 'queued' };
      }}
    />,
  );

  await writeInput(stdin, '\u001B[A');
  expect(lastFrame()).toContain('> ⏳ Queued 2. second queued');

  await writeInput(stdin, 'e');
  expect(lastFrame()).toContain('edit 2 ▸');
  await writeInput(stdin, ' updated');
  await writeInput(stdin, '\r');

  await waitForCondition(
    () => edits.length,
    (count) => count === 1,
  );
  expect(edits).toEqual([{ id: 'q-2', turn: { text: 'second queued updated' } }]);
});

it.sequential('up past the top queued item reaches input history', async () => {
  const historyService = {
    getMessages: () => [],
    getTurns: () => [{ text: 'sent earlier' }],
    addMessage: () => {},
    clear: () => {},
  } as unknown as HistoryService;
  const { lastFrame, stdin } = await renderAndFlush(
    <TestInputBox
      {...defaultProps}
      historyService={historyService}
      pendingQueuedMessages={[{ id: 'q-1', text: 'waiting steer', delivery: 'steer', queuedAt: 1 }]}
    />,
  );

  await writeInput(stdin, '\u001B[A');
  expect(lastFrame()).toContain('> ⏳ Steering 1. waiting steer');
  await writeInput(stdin, '\u001B[A');
  expect(lastFrame()).toMatch(/s\s*e\s*n\s*t\s*e\s*a\s*r\s*l\s*i\s*e\s*r/);
  expect(lastFrame()).not.toContain('> ⏳ Steering');
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

it.sequential('InputBox routes Enter to steer and Alt+Enter to a queued follow-up', async () => {
  const submissions: Array<{ turn: UserTurn; options?: { busyMode?: 'steer' | 'follow_up' } }> = [];
  const { stdin } = await renderAndFlush(
    <TestInputBox
      {...defaultProps}
      onSubmit={(turn: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) => submissions.push({ turn, options })}
    />,
  );

  await writeInput(stdin, 'steer');
  await writeInput(stdin, '\r');
  await writeInput(stdin, 'follow-up');
  await writeInput(stdin, '\x1b\r');

  expect(submissions).toEqual([
    { turn: { text: 'steer' }, options: { busyMode: 'steer' } },
    { turn: { text: 'follow-up' }, options: { busyMode: 'follow_up' } },
  ]);
});

it.sequential('InputBox recognizes Alt+Enter when terminal input arrives in split chunks', async () => {
  const submissions: Array<{ turn: UserTurn; options?: { busyMode?: 'steer' | 'follow_up' } }> = [];
  const { stdin } = await renderAndFlush(
    <TestInputBox
      {...defaultProps}
      onSubmit={(turn: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) => submissions.push({ turn, options })}
    />,
  );

  await writeInput(stdin, 'follow-up\x1b');
  await writeInput(stdin, '\r');

  expect(submissions).toEqual([{ turn: { text: 'follow-up' }, options: { busyMode: 'follow_up' } }]);
});

it.sequential(
  'clears stale trailing Escape in stdin buffer after delay so separate Enter is not misclassified as Alt+Enter',
  async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const submissions: Array<{ turn: UserTurn; options?: { busyMode?: 'steer' | 'follow_up' } }> = [];
    try {
      const { stdin } = await renderAndFlush(
        <TestInputBox
          {...defaultProps}
          allowEmptySubmit={true}
          onSubmit={(turn: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) =>
            submissions.push({ turn, options })
          }
        />,
      );

      await writeInput(stdin, '\x1b');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      await writeInput(stdin, '\r');

      expect(submissions).toEqual([{ turn: { text: '' }, options: { busyMode: 'steer' } }]);
    } finally {
      vi.useRealTimers();
    }
  },
);

it.sequential('preserves a burst of characters while the slash-command popup owns input', async () => {
  let submitted = false;
  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider>
      <StateDisplay />
      <InputBox
        {...defaultProps}
        slashCommands={[{ name: 'usage', description: 'Show usage', action: () => (submitted = true) }]}
      />
    </InputProvider>,
  );

  await writeInput(stdin, '/');
  await waitFor(lastFrame, (value) => value.includes('Input:/|Mode:slash_commands'));

  await act(async () => {
    for (const character of 'usage') {
      stdin.write(character);
    }
  });

  expect(lastFrame()).toContain('Input:/usage|Mode:slash_commands');

  await writeInput(stdin, '\r');
  expect(submitted).toBe(true);
});

it.sequential('opens settings completion with the first Enter after selecting /settings', async () => {
  const settingsCommand: SlashCommand = {
    name: 'settings',
    description: 'Settings',
    expectsArgs: true,
    action: () => false,
    completion: { type: 'settings', trigger: '/settings ', resetTrigger: '/settings reset ' },
  };

  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider>
      <InputCursorStateDisplay />
      <InputBox {...defaultProps} slashCommands={[...mockSlashCommands, settingsCommand]} />
    </InputProvider>,
  );

  await writeInput(stdin, '/settings');
  await waitFor(lastFrame, (frame) => frame.includes('Mode:slash_commands'), { timeoutMs: 3000 });
  await writeInput(stdin, '\r');

  const frame = await waitFor(lastFrame, (value) => value.includes('Mode:settings_completion'), { timeoutMs: 3000 });
  expect(frame).toContain('Input:/settings ');
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

const PathCompletionHarness = () => {
  const { setInput, setCursorOffset, mode } = useInputContext();
  const didSetupRef = useRef(false);

  useEffect(() => {
    if (didSetupRef.current) return;
    didSetupRef.current = true;
    setInput('before @after');
    setCursorOffset(8);
  }, [setInput, setCursorOffset]);

  // Keep the harness rendered until insertion completes so it does not re-run setup.
  return <Text>{mode}</Text>;
};

it.sequential('path completion keeps cursor at end of inserted path in middle of input', async () => {
  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider>
      <CursorState />
      <InputBox {...defaultProps} />
      <PathCompletionHarness />
    </InputProvider>,
  );

  // Wait for path completion popup and the mocked entry to load.
  await waitFor(lastFrame, (f) => f.includes('mock/path'), { timeoutMs: 3000 });
  await flushReactUpdates(10);

  // Press Enter to insert the selected path with a trailing space.
  await writeInput(stdin, '\r');

  // Wait for the popup to close and cursor to stabilize.
  await waitFor(lastFrame, (f) => !f.includes('mock/path'), { timeoutMs: 3000 });
  await flushReactUpdates(10);

  // "before /mock/path after" -> cursor should be at 17 (after inserted path + trailing space),
  // not at the end of the input (22).
  const cursor = getCursorFromFrame(lastFrame());
  expect(cursor).toBe(17);
});

const SettingsCompletionHarness = () => {
  const { setInput, setCursorOffset, mode } = useInputContext();
  const didSetupRef = useRef(false);

  useEffect(() => {
    if (didSetupRef.current) return;
    didSetupRef.current = true;
    const initial = '/settings logging.logLevel';
    setInput(initial);
    setCursorOffset(initial.length);
  }, [setInput, setCursorOffset]);

  return <Text>{mode}</Text>;
};

it.sequential('settings completion keeps cursor at end of inserted key + trailing space', async () => {
  const settingsSlashCommand: SlashCommand = {
    name: '/settings',
    description: 'Settings',
    expectsArgs: true,
    action: () => {},
    completion: { type: 'settings', trigger: SETTINGS_TRIGGER, resetTrigger: '/settings reset ' },
  };
  const slashCommands = [...mockSlashCommands, settingsSlashCommand];

  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider>
      <CursorState />
      <InputBox {...defaultProps} slashCommands={slashCommands} />
      <SettingsCompletionHarness />
    </InputProvider>,
  );

  // Wait for the settings completion popup to show logging.logLevel.
  await waitFor(lastFrame, (f) => f.includes('logging.logLevel'), { timeoutMs: 3000 });
  await flushReactUpdates(10);

  // Press Enter to insert the selected setting key.
  await writeInput(stdin, '\r');

  // Wait for the cursor to move to the end of the inserted key + trailing space.
  const expectedValue = '/settings logging.logLevel ';
  const cursor = await waitForCondition(
    () => getCursorFromFrame(lastFrame()),
    (c) => c === expectedValue.length,
    { timeoutMs: 3000 },
  );
  expect(cursor).toBe(expectedValue.length);
});

const SettingsValueTriggerHarness = () => {
  const { setInput, setCursorOffset } = useInputContext();
  const didSetupRef = useRef(false);

  useEffect(() => {
    if (didSetupRef.current) return;
    didSetupRef.current = true;
    const initial = '/settings agent.reasoningEffort ';
    setInput(initial);
    setCursorOffset(initial.length);
  }, [setInput, setCursorOffset]);

  return null;
};

it.sequential('settings value completion keeps cursor at end of inserted value', async () => {
  const settingsSlashCommand: SlashCommand = {
    name: '/settings',
    description: 'Settings',
    expectsArgs: true,
    action: () => {},
    completion: { type: 'settings', trigger: SETTINGS_TRIGGER, resetTrigger: '/settings reset ' },
  };
  const slashCommands = [...mockSlashCommands, settingsSlashCommand];

  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider>
      <CursorState />
      <InputBox {...defaultProps} slashCommands={slashCommands} />
      <SettingsValueTriggerHarness />
    </InputProvider>,
  );

  // Wait for the value menu to open with the current value (default) selected.
  await waitFor(lastFrame, (f) => f.includes('default'), { timeoutMs: 3000 });
  await flushReactUpdates(10);

  // Press Tab to insert the selected value.
  await writeInput(stdin, '\t');

  // Wait for the cursor to move to the end of the inserted value.
  const expectedValue = '/settings agent.reasoningEffort default';
  const cursor = await waitForCondition(
    () => getCursorFromFrame(lastFrame()),
    (c) => c === expectedValue.length,
    { timeoutMs: 3000 },
  );
  expect(cursor).toBe(expectedValue.length);
});

const StateDisplay = () => {
  const { input, mode } = useInputContext();
  return (
    <Text>
      Input:{input}|Mode:{mode}
    </Text>
  );
};

const InputCursorStateDisplay = () => {
  const { input, mode, cursorOffset } = useInputContext();
  return (
    <Text>
      Input:{input}|Mode:{mode}|Cursor:{cursorOffset}
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
  const { setInput, setCursorOffset, input, mode } = useInputContext();
  const settings = useSettingsCompletion(settingsService);
  const models = useModelSelection({
    loggingService: noopLoggingService,
    settingsService,
  });
  const didCommitRef = useRef(false);

  useEffect(() => {
    setInput(trigger);
    setCursorOffset(trigger.length);
  }, [trigger, setCursorOffset, setInput]);

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
      settingsService.setDynamic(modelKey, selected.id);
      if (models.provider) {
        settingsService.setDynamic(providerKey, models.provider);
      }
      setInput(SETTINGS_TRIGGER);
      setCursorOffset(SETTINGS_TRIGGER.length);
      settings.open(SETTINGS_TRIGGER.length, modelKey);
      return;
    }

    onSubmit?.(insertion.nextValue);
  }, [input, models, onSubmit, setCursorOffset, setInput, settings, settingsService]);

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
  const { setInput, setCursorOffset } = useInputContext();
  const settings = useSettingsCompletion(settingsService);
  const didCommitRef = useRef(false);
  const trigger = '/settings shell.timeout ';
  const restoredInput = `${SETTINGS_TRIGGER}`;

  useEffect(() => {
    setInput(trigger);
    setCursorOffset(trigger.length);
  }, [setCursorOffset, setInput]);

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
    settings.open(SETTINGS_TRIGGER.length, 'shell.timeout');
  }, [reset, restoredInput, setCursorOffset, setInput, settings, settingsService]);

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

const assertSettingsModelTriggerOpensModelMenu = async (
  settingKey: 'agent.smartModel' | 'agent.balancedModel' | 'agent.cheapModel' | 'agent.choreModel',
) => {
  clearModelCache();
  const mockProviderId = `mock-provider-${settingKey.split('.')[1]}-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: mockProviderId,
    label: 'Mock Provider',
    fetchModels: async () => [{ id: 'gpt-test', name: 'GPT Test' }],
  });

  const settingsService = createMockSettingsService({
    'agent.provider': mockProviderId,
  });
  const settingsSlashCommand: SlashCommand = {
    name: '/settings',
    description: 'Settings',
    action: () => {},
    completion: {
      type: 'settings',
      trigger: SETTINGS_TRIGGER,
      resetTrigger: '/settings reset ',
    },
  };

  try {
    const { lastFrame, stdin } = await renderAndFlush(
      <InputProvider>
        <StateDisplay />
        <InputBox
          {...defaultProps}
          settingsService={settingsService}
          slashCommands={[...mockSlashCommands, settingsSlashCommand]}
        />
      </InputProvider>,
    );

    await writeInput(stdin, `${SETTINGS_TRIGGER}${settingKey} `);
    const frame = await waitFor(lastFrame, (f) => f.includes('gpt-test'), { timeoutMs: 3000 });

    expect(frame).toContain('Mode:model_selection');
    expect(frame).toContain('gpt-test');
  } finally {
    clearModelCache();
    unregisterProvider(mockProviderId);
  }
};

it.sequential('smartModel setting opens the model selection menu', async () => {
  await assertSettingsModelTriggerOpensModelMenu('agent.smartModel');
});

it.sequential('balancedModel setting opens the model selection menu', async () => {
  await assertSettingsModelTriggerOpensModelMenu('agent.balancedModel');
});

it.sequential('cheapModel setting opens the model selection menu', async () => {
  await assertSettingsModelTriggerOpensModelMenu('agent.cheapModel');
});

it.sequential('choreModel setting opens the model selection menu', async () => {
  await assertSettingsModelTriggerOpensModelMenu('agent.choreModel');
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

it.sequential(
  'direct /model selection executes the resolved slash command instead of sending it as a chat message',
  async () => {
    clearModelCache();
    const mockProviderId = `mock-provider-command-${Date.now()}-${Math.random()}`;
    registerProvider({
      id: mockProviderId,
      label: 'Mock Provider Command',
      fetchModels: async () => [{ id: 'gpt-test', name: 'GPT Test' }],
    });

    const settingsService = createMockSettingsService({
      'agent.provider': mockProviderId,
    });

    // Named the way real commands are (`model-command.ts` registers
    // `name: 'model'`, no leading slash) so this exercises the same
    // `resolveSlashCommand` matching production goes through.
    const modelAction = vi.fn((args?: string) => {
      settingsService.set('agent.model', args?.split(' ')[0] ?? '');
      return true;
    });
    const modelCommand: SlashCommand = {
      name: 'model',
      description: 'Select model',
      action: modelAction,
      completion: { type: 'model', trigger: '/model ' },
    };
    const slashCommands = [...mockSlashCommands, modelCommand];

    // Mirrors app.tsx's application effect host: a submit-prompt intent is
    // first offered to the shared `tryExecuteSlashCommand` dispatcher (the
    // same function app.tsx's handleSubmit and intent host both call), and
    // only sent to the model as a literal chat message if that dispatcher
    // declines it.
    const sentAsChatMessages: string[] = [];
    const controller = new MenuControllerImpl();
    controller.setIntentHost(({ intentRequest }) => {
      if (intentRequest.intent.type === 'submit-prompt') {
        const handled = tryExecuteSlashCommand(intentRequest.intent.text, slashCommands, () => {});
        if (!handled) {
          sentAsChatMessages.push(intentRequest.intent.text);
        }
      }
      return undefined;
    });

    const { lastFrame, stdin } = await renderAndFlush(
      <InputProvider controller={controller}>
        <StateDisplay />
        <InputBox {...defaultProps} settingsService={settingsService} slashCommands={slashCommands} />
      </InputProvider>,
    );

    await writeInput(stdin, '/model ');
    await waitFor(lastFrame, (f) => f.includes('gpt-test'), { timeoutMs: 3000 });

    await writeInput(stdin, '\r');

    await waitForCondition(
      () => modelAction.mock.calls.length,
      (count) => count === 1,
      { timeoutMs: 3000 },
    );

    // Accepting a direct /model selection must execute the resolved slash
    // command's action (which here sets agent.model) exactly as if the user
    // had typed the whole command and pressed Enter without ever opening the
    // picker — not post the literal command text to the model as a chat
    // message.
    expect(modelAction).toHaveBeenCalledWith(`gpt-test --provider=${mockProviderId}`);
    expect(settingsService.get('agent.model')).toBe('gpt-test');
    expect(sentAsChatMessages).toEqual([]);

    const frame = await waitFor(lastFrame, (f) => f.includes('Mode:text'), { timeoutMs: 3000 });
    expect(frame.includes('Input:|'), frame).toBe(true);

    clearModelCache();
    unregisterProvider(mockProviderId);
  },
);

it.sequential('Ctrl+R refreshes the current provider model list when model selection is open', async () => {
  clearModelCache();
  const mockProviderId = `mock-provider-refresh-${Date.now()}-${Math.random()}`;
  let fetchCount = 0;
  registerProvider({
    id: mockProviderId,
    label: 'Mock Provider Refresh',
    fetchModels: async () => {
      fetchCount += 1;
      return fetchCount === 1 ? [{ id: 'model-a', name: 'Model A' }] : [{ id: 'model-b', name: 'Model B' }];
    },
  });

  const settingsService = createMockSettingsService({
    'agent.provider': mockProviderId,
  });

  const modelCommand: SlashCommand = {
    name: '/model',
    description: 'Select model',
    action: () => {},
    completion: { type: 'model', trigger: '/model ' },
  };

  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider>
      <StateDisplay />
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, modelCommand]}
      />
    </InputProvider>,
  );

  await writeInput(stdin, '/model ');
  await waitFor(lastFrame, (f) => f.includes('model-a'), { timeoutMs: 3000 });
  await writeInput(stdin, '\x12');
  await waitFor(lastFrame, (f) => f.includes('model-b'), { timeoutMs: 3000 });

  expect(fetchCount).toBeGreaterThanOrEqual(2);

  clearModelCache();
  unregisterProvider(mockProviderId);
});

it.sequential('settings-backed model selection saves a typed custom model when no menu item matches', async () => {
  clearModelCache();
  const mockProviderId = `mock-provider-custom-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: mockProviderId,
    label: 'Mock Provider Custom',
    fetchModels: async () => [{ id: 'gpt-test', name: 'GPT Test' }],
  });

  const settingsService = createMockSettingsService({
    'agent.provider': mockProviderId,
  });

  const settingsSlashCommand: SlashCommand = {
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
    <InputProvider controller={createSettingsBackedController(settingsService)}>
      <StateDisplay />
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, settingsSlashCommand]}
      />
    </InputProvider>,
  );

  await writeInput(stdin, '/settings agent.model custom-model');

  await waitFor(lastFrame, (f) => f.includes('No models match "custom-model"'), { timeoutMs: 3000 });

  await writeInput(stdin, '\r');

  await waitForCondition(
    () => settingsService.get('agent.model'),
    (value) => value === 'custom-model',
    { timeoutMs: 3000 },
  );

  expect(settingsService.get('agent.model')).toBe('custom-model');
  expect(settingsService.get('agent.provider')).toBe(mockProviderId);

  const frame = await waitFor(lastFrame, (f) => f.includes('Mode:settings_completion'), { timeoutMs: 3000 });
  expect(frame.includes('Input:/settings '), frame).toBe(true);

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

it.sequential('settings key insertion advances cursor before reopening value completion', async () => {
  const settingsService = createMockSettingsService();
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
      <InputCursorStateDisplay />
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, mockSettingsCommand]}
      />
    </InputProvider>,
  );

  await writeInput(stdin, '/settings shell.timeout');
  await writeInput(stdin, '\r');

  const expectedInput = '/settings shell.timeout ';
  const frame = await waitFor(lastFrame, (f) => f.includes(`Input:${expectedInput}`), { timeoutMs: 3000 });

  expect(frame.includes('Mode:settings_value_completion'), frame).toBe(true);
  expect(frame.includes(`Cursor:${expectedInput.length}`), frame).toBe(true);
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
      <InputProvider controller={createSettingsBackedController(settingsService)}>
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
    <InputProvider controller={createSettingsBackedController(settingsService)}>
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
    <InputProvider
      controller={createSettingsBackedController(settingsService, {
        onSystemMessage: (text) => systemMessages.push(text),
      })}
    >
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
  try {
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

    expect(visibleFrame).toMatch(/▶\s+35/);
    expect(visibleFrame).toContain('Current value');
  } finally {
    process.stdout.columns = originalColumns;
  }
});

it.sequential('InputBox allows backspace and delete keys to modify input in provider wizard phases', async () => {
  const controller = new MenuControllerImpl();
  const settingsService = createMockSettingsService();

  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider controller={controller}>
      <StateDisplay />
      <InputBox {...defaultProps} settingsService={settingsService} />
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
    controller.open({ kind: 'providers' });
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
  expect(toVisibleText(frame)).toContain('Enter Provider Name: a');

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

it.sequential('backspace works after committing a setting value and returning to settings menu', async () => {
  const settingsService = createMockSettingsService({
    'ui.historySize': 50,
  });

  const mockSettingsCommand: SlashCommand = {
    name: '/settings',
    description: 'Settings',
    expectsArgs: true,
    action: () => {},
    completion: {
      type: 'settings',
      trigger: '/settings ',
      resetTrigger: '/settings reset ',
    },
  };

  const { lastFrame, stdin } = await renderAndFlush(
    <InputProvider controller={createSettingsBackedController(settingsService)}>
      <InputCursorStateDisplay />
      <InputBox
        {...defaultProps}
        settingsService={settingsService}
        slashCommands={[...mockSlashCommands, mockSettingsCommand]}
      />
    </InputProvider>,
  );

  // Type "/settings ui.historySize " to enter settings_value_completion.
  // The trailing space after the key name triggers the value menu via
  // determineActiveMenu.
  await writeInput(stdin, '/settings ui.historySize ');

  // Wait for settings_value_completion mode
  await waitFor(lastFrame, (f) => f.includes('Mode:settings_value_completion'), { timeoutMs: 3000 });

  // Press Enter to commit the currently-selected value (50). The
  // settings-value-child frame's Back restores the bare settings prefix
  // (this activation was reached by passively typing the whole trigger, so
  // there was never a mounted settings list with a live filter to return
  // to — see the settingsListRestorePoint note in triggers.ts).
  await writeInput(stdin, '\r');

  // Wait for settings_completion to re-open
  const reopenFrame = await waitFor(lastFrame, (f) => f.includes('Mode:settings_completion'), { timeoutMs: 3000 });
  // After reopen the input should be restored to '/settings '
  expect(reopenFrame.includes('Input:/settings')).toBe(true);

  // Press backspace — cursor is at the end of '/settings ' (10 chars),
  // so backspace should delete the trailing space leaving '/settings'.
  // After deletion, the trigger detection re-classifies the input as a slash
  // command (/settings without trailing space), so mode becomes slash_commands.
  await writeInput(stdin, '\x7f');

  // Wait for the backspace to take effect: input changes from '/settings '
  // to '/settings' (one character shorter), and the mode transitions to
  // slash_commands since '/settings' without trailing space is interpreted
  // as a slash command prefix.
  const frame = await waitFor(lastFrame, (f) => f.includes('Input:/settings|Mode:slash_commands'), { timeoutMs: 3000 });
  // The cursor has moved back by one: '/settings' is 9 chars, cursor at 9.
  expect(frame.includes('Cursor:9')).toBe(true);
});

it.sequential('shows Queue vs Steer guidance and model/effort shortcuts when turnInFlight is active', async () => {
  const { lastFrame } = await renderAndFlush(<TestInputBox {...defaultProps} turnInFlight={true} />);
  const output = lastFrame() ?? '';
  expect(output.includes('Enter Steer active turn')).toBe(true);
  expect(output.includes('Alt+Enter Queue for next turn')).toBe(true);
  expect(output.includes('Ctrl+O model · Ctrl+T effort')).toBe(true);
});

it.sequential('shows Steering label for pending steer submissions', async () => {
  const { lastFrame } = await renderAndFlush(
    <TestInputBox
      {...defaultProps}
      turnInFlight={true}
      pendingQueuedMessages={[{ id: 'q-1', text: 'change direction', delivery: 'steer', queuedAt: 1 }]}
    />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('⏳ Steering 1.')).toBe(true);
  expect(output.includes('⏳ Queued 1.')).toBe(false);
});

it.sequential(
  'shows queue management hint when turnInFlight is active with pending items and empty value',
  async () => {
    const { lastFrame } = await renderAndFlush(
      <TestInputBox
        {...defaultProps}
        turnInFlight={true}
        pendingQueuedMessages={[{ id: 'q-1', text: 'first queued', delivery: 'follow_up', queuedAt: 1 }]}
      />,
    );
    const output = lastFrame() ?? '';
    expect(output.includes('select queued')).toBe(true);
    expect(output.includes('Enter Steer')).toBe(true);
    expect(output.includes('Alt+Enter Queue')).toBe(true);
    expect(output.includes('Ctrl+O model · Ctrl+T effort')).toBe(true);
  },
);
