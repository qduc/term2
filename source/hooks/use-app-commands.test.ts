// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import type { Message } from './use-conversation.js';
import { createCopySlashCommand } from '../commands/copy-command.js';
import { createUsageSlashCommand } from '../commands/usage-command.js';
import { createResumeSlashCommand } from '../commands/resume-command.js';
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

it.sequential('createResumeSlashCommand lists saved conversations in the app', () => {
  const messages: string[] = [];
  const command = createResumeSlashCommand({
    listConversations: () => [{ id: 'saved-1', updatedAt: '2026-08-30T00:00:00.000Z' }],
    resumeConversation: vi.fn(),
    addSystemMessage: (text) => messages.push(text),
  });

  expect(command.action('ls')).toBe(true);
  expect(messages[0]).toContain('saved-1');
  expect(messages[0]).toContain('Resume:  /resume saved-1');
});

it.sequential('createResumeSlashCommand resumes the requested target and rejects extra arguments', async () => {
  const messages: string[] = [];
  const resumeConversation = vi.fn(async () => {});
  const command = createResumeSlashCommand({
    listConversations: () => [],
    resumeConversation,
    addSystemMessage: (text) => messages.push(text),
  });

  expect(command.action('saved-1')).toBe(true);
  await flushMicrotasks();
  expect(resumeConversation).toHaveBeenCalledWith('saved-1');

  expect(command.action('one two')).toBe(true);
  expect(messages).toContain('Usage: /resume [ls | conversation-id]');
  expect(command.action('../outside')).toBe(true);
  expect(messages).toContain('Invalid conversation id. Usage: /resume [ls | conversation-id]');
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

it.sequential('createCopySlashCommand copies the requested assistant response', async () => {
  const copied: string[] = [];
  const command = createCopySlashCommand({
    messages: [
      { id: '1', sender: 'user', text: 'first question' },
      { id: '2', sender: 'bot', text: 'first answer' },
      { id: '3', sender: 'user', text: 'second question' },
      { id: '4', sender: 'bot', text: 'second answer' },
    ],
    addSystemMessage: () => {},
    copy: async (text) => {
      copied.push(text);
    },
  });

  expect(command.action('2')).toBe(true);
  await flushMicrotasks();

  expect(copied).toEqual(['first answer']);
});

it.sequential('createCopySlashCommand rejects invalid response numbers', async () => {
  const systemMessages: string[] = [];
  let copyCalled = false;
  const command = createCopySlashCommand({
    messages: [{ id: '1', sender: 'bot', text: 'hello' }],
    addSystemMessage: (text) => systemMessages.push(text),
    copy: async () => {
      copyCalled = true;
    },
  });

  expect(command.action('0')).toBe(true);
  await flushMicrotasks();

  expect(copyCalled).toBe(false);
  expect(systemMessages).toEqual(['Copy response number must be a positive whole number, e.g. /copy 2.']);
});

it.sequential('createCopySlashCommand opens a selection menu when the response contains code blocks', () => {
  const openCopyMenu = vi.fn();
  const copy = vi.fn(async () => {});
  const command = createCopySlashCommand({
    messages: [
      { id: '1', sender: 'user', text: 'show code' },
      { id: '2', sender: 'bot', text: 'Here it is:\n```ts\nconst answer = 42;\n```' },
    ],
    addSystemMessage: () => {},
    copy,
    openCopyMenu,
  });

  expect(command.action()).toBe(true);
  expect(copy).not.toHaveBeenCalled();
  expect(openCopyMenu).toHaveBeenCalledWith([
    { label: 'Full response', text: 'Here it is:\n```ts\nconst answer = 42;\n```' },
    { label: 'Code block #1', text: 'const answer = 42;' },
  ]);
});

const TestHookWrapper = ({
  settings,
  onHookResult,
  onApply,
  messages = [],
  onSystemMessage,
  requestModeSwitchConfirm,
  turnInFlight,
}: {
  settings: Map<string, any>;
  onHookResult: (res: any) => void;
  onApply?: (key: string, value: any) => void;
  messages?: Message[];
  onSystemMessage?: (text: string) => void;
  requestModeSwitchConfirm?: (pending: any) => void;
  turnInFlight?: boolean;
}) => {
  const settingsService = {
    get: (key: string) => settings.get(key) ?? false,
    set: (key: string, value: any) => settings.set(key, value),
    setDynamic: (key: string, value: any) => {
      settings.set(key, value);
      return { key, value };
    },
    isRuntimeModifiable: () => true,
  } as any;

  const hookResult = useAppCommands({
    settingsService,
    addSystemMessage: (text: string) => onSystemMessage?.(text),
    applyRuntimeSetting: (key: string, value: any) => onApply?.(key, value),
    replaceInput: () => {},
    clearConversation: () => {},
    getSessionUsage: () => '',
    exit: () => {},
    messages,
    setModel: () => {},
    getRewindItems: () => [],
    rewindToTarget: () => null,
    restoreTurnToInput: () => {},
    openRewindMenu: () => {},
    openProvidersMenu: () => {},
    sendUserMessage: async () => {},
    retryLastToolOutput: async () => false,
    skillsService: { getAvailableSkills: () => [] } as any,
    onSkillSelected: () => {},
    requestModeSwitchConfirm,
    turnInFlight,
    listConversations: () => [],
    resumeConversation: () => {},
  });

  onHookResult(hookResult);
  return null;
};

it.sequential('useAppCommands registers /rewind with its aliases and the separate tool retry', async () => {
  const settings = new Map<string, any>();
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  const names = hookResult.slashCommands.map((command: any) => command.name);
  expect(names).toContain('rewind');
  expect(names).toContain('undo');
  expect(names).toContain('retry');
  expect(names).toContain('retry-tool');
  expect(names).toContain('resume');
});

it.sequential('useAppCommands gives /retry a resend default and /undo an edit default', async () => {
  const settings = new Map<string, any>();
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  const find = (name: string) => hookResult.slashCommands.find((command: any) => command.name === name);
  expect(find('retry').description).toContain('resend');
  expect(find('undo').description).toContain('input box');
});

it.sequential('useAppCommands blocks conversation-mutating commands while a turn is in flight', async () => {
  const settings = new Map<string, any>();
  const systemMessages: string[] = [];
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      turnInFlight: true,
      onSystemMessage: (text: string) => systemMessages.push(text),
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  for (const name of ['rewind', 'undo', 'retry', 'clear', 'retry-tool', 'quit', 'compact']) {
    const command = hookResult.slashCommands.find((command: any) => command.name === name);
    expect(command, `command /${name} should be registered`).toBeTruthy();

    let result: boolean | void = false;
    await act(async () => {
      result = command.action();
    });

    expect(result, `/${name} should report handled when blocked`).toBe(true);
    expect(
      systemMessages.some((message) => message.includes(`/${name}`) && message.includes('agent is working')),
      `/${name} should tell the user it is blocked`,
    ).toBe(true);
  }
});

it.sequential('useAppCommands runs the blocked commands normally when the agent is idle', async () => {
  const settings = new Map<string, any>();
  const systemMessages: string[] = [];
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      onSystemMessage: (text: string) => systemMessages.push(text),
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  const clear = hookResult.slashCommands.find((command: any) => command.name === 'clear');
  await act(async () => {
    clear.action();
  });
  expect(systemMessages).toEqual(['Welcome to term²! Type a message to start chatting.']);

  const compact = hookResult.slashCommands.find((command: any) => command.name === 'compact');
  expect(systemMessages.some((message) => message.includes('Compacting'))).toBe(false);
  await act(async () => {
    compact.action();
    await flushMicrotasks();
  });
  expect(systemMessages.some((message) => message.includes('Compacting'))).toBe(true);
  expect(systemMessages.some((message) => message.includes('agent is working'))).toBe(false);
});

it.sequential('useAppCommands leaves display-only commands runnable while a turn is in flight', async () => {
  const settings = new Map<string, any>();
  const systemMessages: string[] = [];
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      turnInFlight: true,
      onSystemMessage: (text: string) => systemMessages.push(text),
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  const usage = hookResult.slashCommands.find((command: any) => command.name === 'usage');
  let result: boolean | void = false;
  await act(async () => {
    result = usage.action();
  });
  expect(result).toBe(true);
  expect(systemMessages.some((message) => message.includes('agent is working'))).toBe(false);
});

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

it.sequential('useAppCommands allows /orchestrator when the session has non-system history', async () => {
  const settings = new Map<string, any>();
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();
  });

  expect(settings.get('app.orchestratorMode')).toBe(true);
});

it.sequential('useAppCommands allows /mentor when the session has non-system history', async () => {
  const settings = new Map<string, any>();
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'mentor').action();
  });

  expect(settings.get('app.mentorMode')).toBe(true);
});

it.sequential('useAppCommands does not request confirmation for /orchestrator when history exists', async () => {
  const settings = new Map<string, any>();
  let requestedPending: any = null;
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
      requestModeSwitchConfirm: (pending) => {
        requestedPending = pending;
      },
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'orchestrator').action();
  });

  expect(requestedPending).toBeNull();
  expect(settings.get('app.orchestratorMode')).toBe(true);
});

it.sequential('useAppCommands requests confirmation for /lite when history exists', async () => {
  const settings = new Map<string, any>();
  let requestedPending: any = null;
  let hookResult: any;

  await renderInAct(
    React.createElement(TestHookWrapper, {
      settings,
      messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
      requestModeSwitchConfirm: (pending) => {
        requestedPending = pending;
      },
      onHookResult: (res) => {
        hookResult = res;
      },
    }),
  );

  await act(async () => {
    hookResult.slashCommands.find((command: any) => command.name === 'lite').action();
  });

  expect(requestedPending).toEqual({
    modeKey: 'app.liteMode',
    modeLabel: 'Lite',
    targetValue: true,
    enabledDetail: ' - using minimal prompt, no codebase context',
  });
});

it.sequential(
  'useAppCommands allows orchestrator settings changes when the session has non-system history',
  async () => {
    const settings = new Map<string, any>();
    let hookResult: any;

    await renderInAct(
      React.createElement(TestHookWrapper, {
        settings,
        messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
        onHookResult: (res) => {
          hookResult = res;
        },
      }),
    );

    await act(async () => {
      hookResult.slashCommands.find((command: any) => command.name === 'settings').action('app.orchestratorMode true');
    });

    expect(settings.get('app.orchestratorMode')).toBe(true);
  },
);

it.sequential(
  'useAppCommands does not request confirmation for orchestrator settings changes when history exists',
  async () => {
    const settings = new Map<string, any>();
    let requestedPending: any = null;
    let hookResult: any;

    await renderInAct(
      React.createElement(TestHookWrapper, {
        settings,
        messages: [{ id: 'msg-1', sender: 'user', text: 'inspect this' }],
        requestModeSwitchConfirm: (pending) => {
          requestedPending = pending;
        },
        onHookResult: (res) => {
          hookResult = res;
        },
      }),
    );

    await act(async () => {
      hookResult.slashCommands.find((command: any) => command.name === 'settings').action('app.orchestratorMode true');
    });

    expect(requestedPending).toBeNull();
    expect(settings.get('app.orchestratorMode')).toBe(true);
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
        replaceInput: () => {},
        clearConversation: () => {
          clearCalled = true;
        },
        getSessionUsage: () => '',
        exit: () => {},
        messages,
        setModel: () => {},
        getRewindItems: () => [],
        rewindToTarget: () => null,
        restoreTurnToInput: () => {},
        openRewindMenu: () => {},
        openProvidersMenu: () => {},
        onHandoff: (text) => {
          handoffText = text;
        },
        sendUserMessage: async () => {},
        retryLastToolOutput: async () => false,
        skillsService: { getAvailableSkills: () => [] } as any,
        onSkillSelected: () => {},
        listConversations: () => [],
        resumeConversation: () => {},
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
