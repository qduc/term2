// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import type { Message } from './use-conversation.js';
import { createCopySlashCommand } from '../commands/copy-command.js';
import { createRetrySlashCommand } from '../commands/retry-command.js';
import { createUndoSlashCommand } from '../commands/undo-command.js';
import { createUsageSlashCommand } from '../commands/usage-command.js';
import { useAppCommands } from './use-app-commands.js';
import { getLastFinalAssistantText } from '../utils/conversation/message-utils.js';
import { parseModelProviderArg } from '../utils/ai/model-provider-arg.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test.serial('getLastFinalAssistantText returns the response from the latest assistant turn', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Hi' },
    { id: '2', sender: 'bot', text: 'First answer' },
    { id: '3', sender: 'user', text: 'Second question' },
    { id: '4', sender: 'bot', text: 'Final answer' },
  ];

  t.is(getLastFinalAssistantText(messages), 'Final answer');
});

test.serial('getLastFinalAssistantText combines contiguous bot messages to return the full message', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Tell me a story' },
    { id: '2', sender: 'bot', text: 'Paragraph 1\n\n' },
    { id: '3', sender: 'bot', text: 'Paragraph 2\n\n' },
    { id: '4', sender: 'bot', text: 'Paragraph 3' },
  ];

  t.is(getLastFinalAssistantText(messages), 'Paragraph 1\n\nParagraph 2\n\nParagraph 3');
});

test.serial('getLastFinalAssistantText ignores reasoning and system messages', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'bot', text: 'Earlier answer' },
    { id: '2', sender: 'reasoning', text: 'hidden chain of thought' },
    { id: '3', sender: 'system', text: 'Stopped' },
  ];

  t.is(getLastFinalAssistantText(messages), 'Earlier answer');
});

test.serial('getLastFinalAssistantText returns null when no bot message exists', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Hi' },
    { id: '2', sender: 'reasoning', text: 'thinking' },
    { id: '3', sender: 'system', text: 'No response yet' },
  ];

  t.is(getLastFinalAssistantText(messages), null);
});

test.serial('parseModelProviderArg supports provider names with spaces for /model', (t) => {
  t.deepEqual(parseModelProviderArg('deepseek-v4-flash --provider=opencode go'), {
    modelId: 'deepseek-v4-flash',
    provider: 'opencode go',
  });
});

test.serial('createUsageSlashCommand shows current session usage', (t) => {
  const messages: string[] = [];
  const command = createUsageSlashCommand(
    (text) => messages.push(text),
    () => 'Token usage: 20,000 input (1,000,000 cached), 20,000 output',
  );

  t.is(command.name, 'usage');
  t.is(command.action(), true);
  t.deepEqual(messages, ['Token usage: 20,000 input (1,000,000 cached), 20,000 output']);
});

test.serial('createCopySlashCommand returns immediately and reports success after async clipboard copy', async (t) => {
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

test.serial('createCopySlashCommand reports clipboard failures asynchronously', async (t) => {
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

test.serial('createUndoSlashCommand opens undo menu when no args', (t) => {
  let menuOpened = false;
  const command = createUndoSlashCommand({
    undoLastUserMessage: () => ({ text: 'Previous message' }),
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

test.serial('createUndoSlashCommand with "last" arg restores last user message to input and returns false', (t) => {
  let input = '';
  let undoRedraws = 0;
  const command = createUndoSlashCommand({
    undoLastUserMessage: () => ({ text: 'Previous message' }),
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

test.serial(
  'createUndoSlashCommand shows system message via undoLastUserMessage when nothing to undo with "last" arg',
  (t) => {
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
  },
);

test.serial('createRetrySlashCommand undoes and re-sends the last user message', async (t) => {
  const systemMessages: string[] = [];
  let undoCalled = false;
  let sentText: string | null = null;
  let undoRedraws = 0;

  const command = createRetrySlashCommand({
    undoLastUserMessage: () => {
      undoCalled = true;
      return { text: 'hello' };
    },
    sendUserMessage: async (input) => {
      sentText = typeof input === 'string' ? input : input.text;
    },
    addSystemMessage: (text) => systemMessages.push(text),
    listUserTurns: () => [{ index: 0, text: 'hello', imageCount: 0 }],
    onUndo: () => {
      undoRedraws++;
    },
  });

  t.is(command.name, 'retry');
  const result = command.action();
  t.is(result, true);
  t.true(undoCalled);
  t.not(sentText, null);
  t.is(sentText!, 'hello');
  t.is(undoRedraws, 1);
  t.deepEqual(systemMessages, []);
});

test.serial('createRetrySlashCommand shows system message when nothing to retry', (t) => {
  const systemMessages: string[] = [];
  let undoCalled = false;

  const command = createRetrySlashCommand({
    undoLastUserMessage: () => {
      undoCalled = true;
      return null;
    },
    sendUserMessage: async () => {},
    addSystemMessage: (text) => systemMessages.push(text),
    listUserTurns: () => [],
  });

  const result = command.action();
  t.is(result, true);
  t.true(undoCalled);
  t.deepEqual(systemMessages, ['Nothing to retry.']);
});

test.serial('createRetrySlashCommand retries when previous turn included images', async (t) => {
  const systemMessages: string[] = [];
  let undoCalled = false;
  let sentInput: any = null;

  const command = createRetrySlashCommand({
    undoLastUserMessage: () => {
      undoCalled = true;
      return {
        text: 'hello',
        images: [{ id: 'img-1', data: 'xyz', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
      };
    },
    sendUserMessage: async (input) => {
      sentInput = input;
    },
    addSystemMessage: (text) => systemMessages.push(text),
    listUserTurns: () => [{ index: 0, text: 'hello', imageCount: 1 }],
  });

  const result = command.action();
  t.is(result, true);
  t.true(undoCalled);
  t.deepEqual(sentInput, {
    text: 'hello',
    images: [{ id: 'img-1', data: 'xyz', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });
  t.deepEqual(systemMessages, []);
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
    openProvidersMenu: () => {},
    sendUserMessage: async () => {},
    listUserTurns: () => [],
  });

  onHookResult(hookResult);
  return null;
};

test.serial('useAppCommands togglePlanMode toggles plan mode', async (t) => {
  const settings = new Map<string, any>();
  const applied: string[] = [];
  let hookResult: any;

  await renderInAct(
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
    t,
  );

  // Toggle planMode ON
  await act(async () => {
    hookResult.togglePlanMode();
  });
  t.true(settings.get('app.planMode'));
  t.true(applied.includes('app.planMode'));

  // Toggle planMode OFF
  await act(async () => {
    hookResult.togglePlanMode();
  });
  t.false(settings.get('app.planMode'));
});

test.serial('useAppCommands cycleAppModes cycles Standard -> Plan -> Standard', async (t) => {
  const settings = new Map<string, any>();
  const applied: string[] = [];
  let hookResult: any;

  await renderInAct(
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
    t,
  );

  // Starts in Standard (planMode false)
  t.falsy(settings.get('app.planMode'));

  // Standard -> Plan
  await act(async () => {
    hookResult.cycleAppModes();
  });
  t.true(settings.get('app.planMode'));

  // Plan -> Standard
  await act(async () => {
    hookResult.cycleAppModes();
  });
  t.false(settings.get('app.planMode'));
});

test.serial('useAppCommands /orchestrator enables exclusive orchestrator mode', async (t) => {
  const settings = new Map<string, any>([
    ['app.liteMode', true],
    ['app.mentorMode', true],
    ['app.planMode', true],
  ]);
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => settings.set(key, value),
    }),
    t,
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();
  });

  t.true(settings.get('app.orchestratorMode'));
  t.false(settings.get('app.liteMode'));
  t.false(settings.get('app.mentorMode'));
  t.false(settings.get('app.planMode'));
});

test.serial('useAppCommands blocks /orchestrator when the session has non-system history', async (t) => {
  const settings = new Map<string, any>();
  const systemMessages: string[] = [];
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
      onSystemMessage: (text: string) => systemMessages.push(text),
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
    t,
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();
  });

  t.falsy(settings.get('app.orchestratorMode'));
  t.true(systemMessages.some((message) => message.includes('/clear')));
});

test.serial(
  'useAppCommands blocks orchestrator settings changes when the session has non-system history',
  async (t) => {
    const settings = new Map<string, any>();
    const systemMessages: string[] = [];
    let hookResult: any;

    await renderInAct(
      React.createElement(TestHookWrapper, {
        settings,
        messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
        onSystemMessage: (text: string) => systemMessages.push(text),
        onHookResult: (res) => {
          hookResult = res;
        },
      }),
      t,
    );

    await act(async () => {
      hookResult.slashCommands.find((command: any) => command.name === 'settings').action('app.orchestratorMode true');
    });

    t.falsy(settings.get('app.orchestratorMode'));
    t.true(systemMessages.some((message) => message.includes('/clear')));
  },
);

test.serial('useAppCommands enabling orchestrator disables all of: lite, plan, mentor', async (t) => {
  const settings = new Map<string, any>([
    ['app.liteMode', true],
    ['app.planMode', true],
    ['app.mentorMode', true],
    ['app.orchestratorMode', false],
  ]);
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => settings.set(key, value),
    }),
    t,
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();
  });

  t.true(settings.get('app.orchestratorMode'));
  t.false(settings.get('app.liteMode'));
  t.false(settings.get('app.planMode'));
  t.false(settings.get('app.mentorMode'));
});

test.serial('useAppCommands enabling plan disables all of: lite, orchestrator, mentor', async (t) => {
  const settings = new Map<string, any>([
    ['app.liteMode', true],
    ['app.orchestratorMode', true],
    ['app.mentorMode', true],
    ['app.planMode', false],
  ]);
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => settings.set(key, value),
    }),
    t,
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'plan').action();
  });

  t.true(settings.get('app.planMode'));
  t.false(settings.get('app.liteMode'));
  t.false(settings.get('app.orchestratorMode'));
  t.false(settings.get('app.mentorMode'));
});

test.serial('useAppCommands cycleAppModes when in mentor mode switches to plan and disables mentor', async (t) => {
  const settings = new Map<string, any>([
    ['app.mentorMode', true],
    ['app.planMode', false],
  ]);
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
      onApply: (key: string, value: any) => settings.set(key, value),
    }),
    t,
  );

  await act(async () => {
    hookResult.cycleAppModes();
  });

  t.true(settings.get('app.planMode'));
  t.false(settings.get('app.mentorMode'));
});

test.serial('useAppCommands /handoff when no assistant response exists shows system message', async (t) => {
  const settings = new Map<string, any>();
  const systemMessages: string[] = [];
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      messages: [{ id: 'msg-1', sender: 'user', text: 'hello' }],
      onSystemMessage: (text: string) => systemMessages.push(text),
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
    t,
  );

  const command = hookResult.slashCommands.find((c: any) => c.name === 'handoff');
  t.truthy(command);
  let result = false;
  await act(async () => {
    result = command.action();
  });
  t.is(result, true);
  t.deepEqual(systemMessages, ['No assistant response available to hand off.']);
});

test.serial(
  'useAppCommands /handoff when assistant response exists copies, clears, message, and calls onHandoff',
  async (t) => {
    const settings = new Map<string, any>();
    const systemMessages: string[] = [];
    let clearCalled = false;
    let handoffText: string | null = null;
    let hookResult: any;

    const messages: Message[] = [
      { id: '1', sender: 'user', text: 'please write a plan' },
      { id: '2', sender: 'bot', text: 'my plan' },
    ];

    const TestWrapper = () => {
      hookResult = useAppCommands({
        settingsService: {
          get: (key: string) => settings.get(key) ?? false,
          set: (key: string, value: any) => settings.set(key, value),
        } as any,
        addSystemMessage: (text: string) => systemMessages.push(text),
        applyRuntimeSetting: () => {},
        setInput: () => {},
        clearConversation: () => {
          clearCalled = true;
        },
        getSessionUsage: () => '',
        exit: () => {},
        messages,
        setModel: () => {},
        undoLastUserMessage: () => null,
        openUndoMenu: () => {},
        openProvidersMenu: () => {},
        onHandoff: (text) => {
          handoffText = text;
        },
        sendUserMessage: async () => {},
        listUserTurns: () => [],
      });
      return null;
    };

    let unmount: () => void;

    await act(async () => {
      ({ unmount } = render(React.createElement(TestWrapper)));
      await Promise.resolve();
    });

    const command = hookResult.slashCommands.find((c: any) => c.name === 'handoff');
    t.truthy(command);
    let result = false;
    await act(async () => {
      result = command.action();
      await flushMicrotasks();
    });
    t.is(result, true);
    t.false(clearCalled);

    t.is(handoffText as any, 'my plan');
    t.deepEqual(systemMessages, []);

    await act(async () => {
      unmount();
    });
  },
);
