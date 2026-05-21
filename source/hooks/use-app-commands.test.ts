import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Message } from './use-conversation.js';
import {
  createCopySlashCommand,
  createUndoSlashCommand,
  createUsageSlashCommand,
  getLastFinalAssistantText,
  useAppCommands,
} from './use-app-commands.js';
import { parseModelProviderArg } from '../utils/model-provider-arg.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('getLastFinalAssistantText returns the response from the latest assistant turn', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Hi' },
    { id: '2', sender: 'bot', text: 'First answer' },
    { id: '3', sender: 'user', text: 'Second question' },
    { id: '4', sender: 'bot', text: 'Final answer' },
  ];

  t.is(getLastFinalAssistantText(messages), 'Final answer');
});

test('getLastFinalAssistantText combines contiguous bot messages to return the full message', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Tell me a story' },
    { id: '2', sender: 'bot', text: 'Paragraph 1\n\n' },
    { id: '3', sender: 'bot', text: 'Paragraph 2\n\n' },
    { id: '4', sender: 'bot', text: 'Paragraph 3' },
  ];

  t.is(getLastFinalAssistantText(messages), 'Paragraph 1\n\nParagraph 2\n\nParagraph 3');
});

test('getLastFinalAssistantText ignores reasoning and system messages', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'bot', text: 'Earlier answer' },
    { id: '2', sender: 'reasoning', text: 'hidden chain of thought' },
    { id: '3', sender: 'system', text: 'Stopped' },
  ];

  t.is(getLastFinalAssistantText(messages), 'Earlier answer');
});

test('getLastFinalAssistantText returns null when no bot message exists', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Hi' },
    { id: '2', sender: 'reasoning', text: 'thinking' },
    { id: '3', sender: 'system', text: 'No response yet' },
  ];

  t.is(getLastFinalAssistantText(messages), null);
});

test('parseModelProviderArg supports provider names with spaces for /model', (t) => {
  t.deepEqual(parseModelProviderArg('deepseek-v4-flash --provider=opencode go'), {
    modelId: 'deepseek-v4-flash',
    provider: 'opencode go',
  });
});

test('createUsageSlashCommand shows current session usage', (t) => {
  const messages: string[] = [];
  const command = createUsageSlashCommand(
    (text) => messages.push(text),
    () => 'Token usage: 20,000 input (1,000,000 cached), 20,000 output',
  );

  t.is(command.name, 'usage');
  t.is(command.action(), true);
  t.deepEqual(messages, ['Token usage: 20,000 input (1,000,000 cached), 20,000 output']);
});

test('createCopySlashCommand returns immediately and reports success after async clipboard copy', async (t) => {
  const systemMessages: string[] = [];
  let resolveCopy: (() => void) | undefined;
  const command = createCopySlashCommand({
    messages: [{ id: '1', sender: 'bot', text: 'hello' }],
    addSystemMessage: (text) => systemMessages.push(text),
    copy: () =>
      new Promise<void>((resolve) => {
        resolveCopy = resolve;
      }),
  });

  t.is(command.action(), true);
  t.deepEqual(systemMessages, []);

  resolveCopy?.();
  await flushMicrotasks();

  t.deepEqual(systemMessages, ['Copied the latest assistant response to the clipboard.']);
});

test('createCopySlashCommand reports clipboard failures asynchronously', async (t) => {
  const systemMessages: string[] = [];
  const command = createCopySlashCommand({
    messages: [{ id: '1', sender: 'bot', text: 'hello' }],
    addSystemMessage: (text) => systemMessages.push(text),
    copy: async () => {
      throw new Error('clipboard unavailable');
    },
  });

  t.is(command.action(), true);
  await flushMicrotasks();

  t.deepEqual(systemMessages, ['Failed to copy to clipboard: clipboard unavailable']);
});

test('createUndoSlashCommand opens undo menu when no args', (t) => {
  let menuOpened = false;
  const command = createUndoSlashCommand({
    undoLastUserMessage: () => 'Previous message',
    setInput: () => {},
    addSystemMessage: () => {},
    openUndoMenu: () => {
      menuOpened = true;
    },
  });

  const result = command.action();
  t.is(result, true);
  t.true(menuOpened);
});

test('createUndoSlashCommand with "last" arg restores last user message to input and returns false', (t) => {
  let input = '';
  let undoRedraws = 0;
  const command = createUndoSlashCommand({
    undoLastUserMessage: () => 'Previous message',
    setInput: (value) => {
      input = value;
    },
    addSystemMessage: () => {},
    openUndoMenu: () => {},
    onUndo: () => {
      undoRedraws++;
    },
  });

  t.is(command.name, 'undo');
  const result = command.action('last');
  t.is(result, false);
  t.is(input, 'Previous message');
  t.is(undoRedraws, 1);
});

test('createUndoSlashCommand shows system message via undoLastUserMessage when nothing to undo with "last" arg', (t) => {
  const systemMessages: string[] = [];
  let undoRedraws = 0;
  const command = createUndoSlashCommand({
    undoLastUserMessage: () => null,
    setInput: () => {},
    addSystemMessage: (text) => systemMessages.push(text),
    openUndoMenu: () => {},
    onUndo: () => {
      undoRedraws++;
    },
  });

  const result = command.action('last');
  t.is(result, true);
  t.deepEqual(systemMessages, ['Nothing to undo.']);
  t.is(undoRedraws, 0);
});

const TestHookWrapper = ({
  settings,
  onHookResult,
  onApply,
  messages = [],
  onSystemMessage,
}: {
  settings: Map<string, any>;
  onHookResult: (res: any) => void;
  onApply?: (key: string, value: any) => void;
  messages?: Message[];
  onSystemMessage?: (text: string) => void;
}) => {
  const settingsService = {
    get: (key: string) => settings.get(key) ?? false,
    set: (key: string, value: any) => settings.set(key, value),
  } as any;

  const hookResult = useAppCommands({
    settingsService,
    addSystemMessage: (text: string) => onSystemMessage?.(text),
    applyRuntimeSetting: (key: string, value: any) => onApply?.(key, value),
    setInput: () => {},
    clearConversation: () => {},
    getSessionUsage: () => '',
    exit: () => {},
    messages,
    setModel: () => {},
    undoLastUserMessage: () => null,
    openUndoMenu: () => {},
  });

  onHookResult(hookResult);
  return null;
};

test('useAppCommands togglePlanMode toggles plan mode', (t) => {
  const settings = new Map<string, any>();
  const applied: string[] = [];
  let hookResult: any;

  render(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => {
        applied.push(key);
        settings.set(key, value);
      },
    }),
  );

  // Toggle planMode ON
  hookResult.togglePlanMode();
  t.true(settings.get('app.planMode'));
  t.true(applied.includes('app.planMode'));

  // Toggle planMode OFF
  hookResult.togglePlanMode();
  t.false(settings.get('app.planMode'));
});

test('useAppCommands cycleAppModes cycles Standard -> Plan -> Standard', (t) => {
  const settings = new Map<string, any>();
  const applied: string[] = [];
  let hookResult: any;

  render(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => {
        applied.push(key);
        settings.set(key, value);
      },
    }),
  );

  // Starts in Standard (planMode false)
  t.falsy(settings.get('app.planMode'));

  // Standard -> Plan
  hookResult.cycleAppModes();
  t.true(settings.get('app.planMode'));

  // Plan -> Standard
  hookResult.cycleAppModes();
  t.false(settings.get('app.planMode'));
});

test('useAppCommands /orchestrator enables exclusive orchestrator mode', (t) => {
  const settings = new Map<string, any>([
    ['app.liteMode', true],
    ['app.mentorMode', true],
    ['app.planMode', true],
  ]);
  let hookResult: any;

  render(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => settings.set(key, value),
    }),
  );

  hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();

  t.true(settings.get('app.orchestratorMode'));
  t.false(settings.get('app.liteMode'));
  t.false(settings.get('app.mentorMode'));
  t.false(settings.get('app.planMode'));
});

test('useAppCommands blocks /orchestrator when the session has non-system history', (t) => {
  const settings = new Map<string, any>();
  const systemMessages: string[] = [];
  let hookResult: any;

  render(
    React.createElement(TestHookWrapper, {
      settings,
      messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
      onSystemMessage: (text: string) => systemMessages.push(text),
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();

  t.falsy(settings.get('app.orchestratorMode'));
  t.true(systemMessages.some((message) => message.includes('/clear')));
});

test('useAppCommands blocks orchestrator settings changes when the session has non-system history', (t) => {
  const settings = new Map<string, any>();
  const systemMessages: string[] = [];
  let hookResult: any;

  render(
    React.createElement(TestHookWrapper, {
      settings,
      messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
      onSystemMessage: (text: string) => systemMessages.push(text),
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  hookResult.slashCommands.find((command: any) => command.name === 'settings').action('app.orchestratorMode true');

  t.falsy(settings.get('app.orchestratorMode'));
  t.true(systemMessages.some((message) => message.includes('/clear')));
});

test('useAppCommands enabling orchestrator disables all of: lite, plan, mentor', (t) => {
  const settings = new Map<string, any>([
    ['app.liteMode', true],
    ['app.planMode', true],
    ['app.mentorMode', true],
    ['app.orchestratorMode', false],
  ]);
  let hookResult: any;

  render(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => settings.set(key, value),
    }),
  );

  hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();

  t.true(settings.get('app.orchestratorMode'));
  t.false(settings.get('app.liteMode'));
  t.false(settings.get('app.planMode'));
  t.false(settings.get('app.mentorMode'));
});

test('useAppCommands enabling plan disables all of: lite, orchestrator, mentor', (t) => {
  const settings = new Map<string, any>([
    ['app.liteMode', true],
    ['app.orchestratorMode', true],
    ['app.mentorMode', true],
    ['app.planMode', false],
  ]);
  let hookResult: any;

  render(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => settings.set(key, value),
    }),
  );

  hookResult.slashCommands.find((command: any) => command.name === 'plan').action();

  t.true(settings.get('app.planMode'));
  t.false(settings.get('app.liteMode'));
  t.false(settings.get('app.orchestratorMode'));
  t.false(settings.get('app.mentorMode'));
});

test('useAppCommands cycleAppModes when in mentor mode switches to plan and disables mentor', (t) => {
  const settings = new Map<string, any>([
    ['app.mentorMode', true],
    ['app.planMode', false],
  ]);
  let hookResult: any;

  render(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => settings.set(key, value),
    }),
  );

  hookResult.cycleAppModes();

  t.true(settings.get('app.planMode'));
  t.false(settings.get('app.mentorMode'));
});
