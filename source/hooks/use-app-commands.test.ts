// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
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

it.sequential('getLastFinalAssistantText returns the response from the latest assistant turn', () => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Hi' },
    { id: '2', sender: 'bot', text: 'First answer' },
    { id: '3', sender: 'user', text: 'Second question' },
    { id: '4', sender: 'bot', text: 'Final answer' },
  ];

  expect(getLastFinalAssistantText(messages)).toBe('Final answer');
});

it.sequential('getLastFinalAssistantText combines contiguous bot messages to return the full message', () => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Tell me a story' },
    { id: '2', sender: 'bot', text: 'Paragraph 1\n\n' },
    { id: '3', sender: 'bot', text: 'Paragraph 2\n\n' },
    { id: '4', sender: 'bot', text: 'Paragraph 3' },
  ];

  expect(getLastFinalAssistantText(messages)).toBe('Paragraph 1\n\nParagraph 2\n\nParagraph 3');
});

it.sequential('getLastFinalAssistantText ignores reasoning and system messages', () => {
  const messages: Message[] = [
    { id: '1', sender: 'bot', text: 'Earlier answer' },
    { id: '2', sender: 'reasoning', text: 'hidden chain of thought' },
    { id: '3', sender: 'system', text: 'Stopped' },
  ];

  expect(getLastFinalAssistantText(messages)).toBe('Earlier answer');
});

it.sequential('getLastFinalAssistantText returns null when no bot message exists', () => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Hi' },
    { id: '2', sender: 'reasoning', text: 'thinking' },
    { id: '3', sender: 'system', text: 'No response yet' },
  ];

  expect(getLastFinalAssistantText(messages)).toBe(null);
});

it.sequential('parseModelProviderArg supports provider names with spaces for /model', () => {
  expect(parseModelProviderArg('deepseek-v4-flash --provider=opencode go')).toEqual({
    modelId: 'deepseek-v4-flash',
    provider: 'opencode go',
  });
});

it.sequential('createUsageSlashCommand shows current session usage', () => {
  const messages: string[] = [];
  const command = createUsageSlashCommand(
    (text) => messages.push(text),
    () => 'Token usage: 20,000 input (1,000,000 cached), 20,000 output',
  );

  expect(command.name).toBe('usage');
  expect(command.action()).toBe(true);
  expect(messages).toEqual(['Token usage: 20,000 input (1,000,000 cached), 20,000 output']);
});

it.sequential('createCopySlashCommand returns immediately and reports success after async clipboard copy', async () => {
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

  expect(command.action()).toBe(true);
  expect(systemMessages).toEqual([]);

  resolveCopy?.();
  await flushMicrotasks();

  expect(systemMessages).toEqual(['Copied the latest assistant response to the clipboard.']);
});

it.sequential('createCopySlashCommand reports clipboard failures asynchronously', async () => {
  const systemMessages: string[] = [];
  const command = createCopySlashCommand({
    messages: [{ id: '1', sender: 'bot', text: 'hello' }],
    addSystemMessage: (text) => systemMessages.push(text),
    copy: async () => {
      throw new Error('clipboard unavailable');
    },
  });

  expect(command.action()).toBe(true);
  await flushMicrotasks();

  expect(systemMessages).toEqual(['Failed to copy to clipboard: clipboard unavailable']);
});

it.sequential('createUndoSlashCommand opens undo menu when no args', () => {
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
  expect(result).toBe(true);
  expect(menuOpened).toBe(true);
});

it.sequential('createUndoSlashCommand with "last" arg restores last user message to input and returns false', () => {
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

  expect(command.name).toBe('undo');
  const result = command.action('last');
  expect(result).toBe(false);
  expect(input).toBe('Previous message');
  expect(undoRedraws).toBe(1);
});

it.sequential(
  'createUndoSlashCommand shows system message via undoLastUserMessage when nothing to undo with "last" arg',
  () => {
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
    expect(result).toBe(true);
    expect(systemMessages).toEqual(['Nothing to undo.']);
    expect(undoRedraws).toBe(0);
  },
);

it.sequential('createRetrySlashCommand undoes and re-sends the last user message', async () => {
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

  expect(command.name).toBe('retry');
  const result = command.action();
  expect(result).toBe(true);
  expect(undoCalled).toBe(true);
  expect(sentText).not.toBe(null);
  expect(sentText!).toBe('hello');
  expect(undoRedraws).toBe(1);
  expect(systemMessages).toEqual([]);
});

it.sequential('createRetrySlashCommand shows system message when nothing to retry', () => {
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
  expect(result).toBe(true);
  expect(undoCalled).toBe(true);
  expect(systemMessages).toEqual(['Nothing to retry.']);
});

it.sequential('createRetrySlashCommand retries when previous turn included images', async () => {
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
  expect(result).toBe(true);
  expect(undoCalled).toBe(true);
  expect(sentInput).toEqual({
    text: 'hello',
    images: [{ id: 'img-1', data: 'xyz', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });
  expect(systemMessages).toEqual([]);
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
    skillsService: { getAvailableSkills: () => [] } as any,
    onSkillSelected: () => {},
  });

  onHookResult(hookResult);
  return null;
};

it.sequential('useAppCommands togglePlanMode toggles plan mode', async () => {
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
  );

  // Toggle planMode ON
  await act(async () => {
    hookResult.togglePlanMode();
  });
  expect(settings.get('app.planMode')).toBe(true);
  expect(applied.includes('app.planMode')).toBe(true);

  // Toggle planMode OFF
  await act(async () => {
    hookResult.togglePlanMode();
  });
  expect(settings.get('app.planMode')).toBe(false);
});

it.sequential('useAppCommands cycleAppModes cycles Standard -> Plan -> Standard', async () => {
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
  );

  // Starts in Standard (planMode false)
  expect(settings.get('app.planMode')).toBeFalsy();

  // Standard -> Plan
  await act(async () => {
    hookResult.cycleAppModes();
  });
  expect(settings.get('app.planMode')).toBe(true);

  // Plan -> Standard
  await act(async () => {
    hookResult.cycleAppModes();
  });
  expect(settings.get('app.planMode')).toBe(false);
});

it.sequential('useAppCommands /orchestrator enables exclusive orchestrator mode', async () => {
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
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();
  });

  expect(settings.get('app.orchestratorMode')).toBe(true);
  expect(settings.get('app.liteMode')).toBe(false);
  expect(settings.get('app.mentorMode')).toBe(false);
  expect(settings.get('app.planMode')).toBe(false);
});

it.sequential('useAppCommands blocks /orchestrator when the session has non-system history', async () => {
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
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();
  });

  expect(settings.get('app.orchestratorMode')).toBeFalsy();
  expect(systemMessages.some((message) => message.includes('/clear'))).toBe(true);
});

it.sequential(
  'useAppCommands blocks orchestrator settings changes when the session has non-system history',
  async () => {
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
    );

    await act(async () => {
      hookResult.slashCommands.find((command: any) => command.name === 'settings').action('app.orchestratorMode true');
    });

    expect(settings.get('app.orchestratorMode')).toBeFalsy();
    expect(systemMessages.some((message) => message.includes('/clear'))).toBe(true);
  },
);

it.sequential('useAppCommands enabling orchestrator disables all of: lite, plan, mentor', async () => {
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
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();
  });

  expect(settings.get('app.orchestratorMode')).toBe(true);
  expect(settings.get('app.liteMode')).toBe(false);
  expect(settings.get('app.planMode')).toBe(false);
  expect(settings.get('app.mentorMode')).toBe(false);
});

it.sequential('useAppCommands enabling plan disables all of: lite, orchestrator, mentor', async () => {
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
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'plan').action();
  });

  expect(settings.get('app.planMode')).toBe(true);
  expect(settings.get('app.liteMode')).toBe(false);
  expect(settings.get('app.orchestratorMode')).toBe(false);
  expect(settings.get('app.mentorMode')).toBe(false);
});

it.sequential('useAppCommands cycleAppModes when in mentor mode switches to plan and disables mentor', async () => {
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
  );

  await act(async () => {
    hookResult.cycleAppModes();
  });

  expect(settings.get('app.planMode')).toBe(true);
  expect(settings.get('app.mentorMode')).toBe(false);
});

it.sequential('useAppCommands /handoff when no assistant response exists shows system message', async () => {
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
  );

  const command = hookResult.slashCommands.find((c: any) => c.name === 'handoff');
  expect(command).toBeTruthy();
  let result = false;
  await act(async () => {
    result = command.action();
  });
  expect(result).toBe(true);
  expect(systemMessages).toEqual(['No assistant response available to hand off.']);
});

it.sequential(
  'useAppCommands /handoff when assistant response exists copies, clears, message, and calls onHandoff',
  async () => {
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
        skillsService: { getAvailableSkills: () => [] } as any,
        onSkillSelected: () => {},
      });
      return null;
    };

    let unmount: () => void;

    await act(async () => {
      ({ unmount } = render(React.createElement(TestWrapper)));
      await Promise.resolve();
    });

    const command = hookResult.slashCommands.find((c: any) => c.name === 'handoff');
    expect(command).toBeTruthy();
    let result = false;
    await act(async () => {
      result = command.action();
      await flushMicrotasks();
    });
    expect(result).toBe(true);
    expect(clearCalled).toBe(false);

    expect(handoffText as any).toBe('my plan');
    expect(systemMessages).toEqual([]);

    await act(async () => {
      unmount();
    });
  },
);
