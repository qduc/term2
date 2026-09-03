// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act, useEffect } from 'react';
import { useStdin } from 'ink';
import { it, expect, vi } from 'vitest';
import ApplicationInputSurface from './ApplicationInputSurface.js';
import { InputProvider, useInputContext } from '../../context/InputContext.js';
import { MenuControllerImpl } from './menu-controller.js';
import type { HistoryService } from '../../services/history-service.js';
import type { LoggingService } from '../../services/logging/logging-service.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { SkillInfo, SkillsService } from '../../services/skills/skills-service.js';
import type { CopySelection } from '../../utils/copy-selections.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';

vi.mock('../../services/file-service.js', () => ({
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

const loggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
} as unknown as LoggingService;

const historyService = {
  getMessages: () => [],
  getTurns: () => [],
  addMessage: () => {},
  clear: () => {},
} as unknown as HistoryService;

const slashCommands: SlashCommand[] = [{ name: '/clear', description: 'Clear', action: () => {} }];

const settingsCommand: SlashCommand = {
  name: 'settings',
  description: 'Settings',
  expectsArgs: true,
  action: () => false,
  completion: { type: 'settings', trigger: '/settings ', resetTrigger: '/settings reset ' },
};

const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Model',
  expectsArgs: true,
  action: () => false,
  completion: { type: 'model', trigger: '/model ' },
};

const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'Skills',
  expectsArgs: true,
  action: () => false,
  completion: { type: 'skills', trigger: '/skills ' },
};

const autoApproveCommand: SlashCommand = {
  name: 'auto-approve',
  description: 'Auto approve',
  expectsArgs: true,
  action: () => false,
  completion: { type: 'setting-value', trigger: '/auto-approve ', settingKey: 'shell.autoApproveMode' },
};

const resumeCommand: SlashCommand = {
  name: 'resume',
  description: 'Resume',
  expectsArgs: true,
  action: () => false,
  completion: { type: 'resume', trigger: '/resume ' },
};

const profileCommand: SlashCommand = {
  name: 'profile',
  description: 'Profile',
  expectsArgs: true,
  action: () => false,
  completion: { type: 'profile', trigger: '/profile ' },
};

const copySelections: CopySelection[] = [
  { label: 'Full response', text: 'answer\n```\ncode\n```' },
  { label: 'Code block #1', text: 'code' },
];

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 2; i++) await new Promise((resolve) => setImmediate(resolve));
  });
};

const renderSurface = async (
  controller: MenuControllerImpl,
  commands = slashCommands,
  children?: React.ReactNode,
  options?: {
    skillsService?: SkillsService;
    onSkillSelected?: (skill: SkillInfo) => void;
    onSystemMessage?: (text: string) => void;
    onCopySelection?: (selection: CopySelection) => void;
    listConversations?: () => import('../../services/conversation/conversation-persistence.js').ConversationListEntry[];
    resumeConversation?: (target?: string) => void | Promise<void>;
  },
) => {
  const result = await renderInAct(
    <InputProvider controller={controller}>
      <ApplicationInputSurface
        enabled
        onSubmit={async () => {}}
        slashCommands={commands}
        settingsService={createMockSettingsService()}
        loggingService={loggingService}
        historyService={historyService}
        skillsService={options?.skillsService}
        onSkillSelected={options?.onSkillSelected}
        onSystemMessage={options?.onSystemMessage}
        onCopySelection={options?.onCopySelection}
        listConversations={options?.listConversations}
        resumeConversation={options?.resumeConversation}
      />
      {children}
    </InputProvider>,
  );
  await settle();
  return result;
};

const SeedInput = ({ text, cursor }: { text: string; cursor: number }) => {
  const { setInput, setCursorOffset } = useInputContext();

  useEffect(() => {
    setInput(text);
    setCursorOffset(cursor);
  }, [cursor, setCursorOffset, setInput, text]);

  return null;
};

type InputEmitter = { emit: (event: string, input: string) => void };

const CaptureInputEmitter = ({ onEmitter }: { onEmitter: (emitter: InputEmitter) => void }) => {
  const stdin = useStdin() as unknown as { internal_eventEmitter: InputEmitter };

  useEffect(() => {
    onEmitter(stdin.internal_eventEmitter);
  }, [onEmitter, stdin]);

  return null;
};

const writeInput = async (stdin: { write: (input: string) => void }, input: string) => {
  await act(async () => {
    stdin.write(input);
    await settle();
  });
};

const waitFor = async (predicate: () => boolean, description = 'menu state', diagnostic?: () => string) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}${diagnostic ? `: ${diagnostic()}` : ''}`);
    }
    await settle();
  }
};

it.sequential('opens the slash menu and Escape cancels it through the terminal boundary', async () => {
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(controller);

  await writeInput(stdin, '/');
  await waitFor(() => (lastFrame() ?? '').includes('/clear'));

  await writeInput(stdin, '\u001b');
  await waitFor(() => controller.getSnapshot().stack.length === 0);

  expect(controller.getSnapshot().editor.text).toBe('');
  expect(lastFrame()).not.toContain('/clear');
});

it.sequential('copy menu owns keyboard input and accepts the selected code block', async () => {
  const controller = new MenuControllerImpl();
  const onCopySelection = vi.fn();
  const { lastFrame, stdin } = await renderSurface(controller, slashCommands, undefined, { onCopySelection });

  controller.open({ kind: 'copy', items: copySelections });
  await waitFor(() => (lastFrame() ?? '').includes('Code block #1'));

  await writeInput(stdin, '\u001b[B');
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.length === 0);

  expect(onCopySelection).toHaveBeenCalledWith(copySelections[1]);
});

it.sequential('clears a slash command when Escape arrives during the menu handoff', async () => {
  const controller = new MenuControllerImpl();
  let inputEmitter: { emit: (event: string, input: string) => void } | null = null;
  await renderSurface(
    controller,
    slashCommands,
    <CaptureInputEmitter onEmitter={(emitter) => (inputEmitter = emitter)} />,
  );

  await act(async () => {
    // Seed the controller synchronously so Escape exercises the ownership
    // handoff itself, before the replacement surface's passive effect runs.
    controller.replaceText('/');
    inputEmitter!.emit('input', '\u001b');
    await settle();
  });

  expect(controller.getSnapshot().stack).toHaveLength(0);
  expect(controller.getSnapshot().editor.text).toBe('');
});

it.sequential('filters a path trigger and inserts the selected entry with a trailing space', async () => {
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(
    controller,
    slashCommands,
    <SeedInput text="before @after" cursor={8} />,
  );

  await waitFor(
    () => (lastFrame() ?? '').includes('mock/path'),
    'path menu',
    () =>
      `stack=${controller
        .getSnapshot()
        .stack.map((frame) => frame.kind)
        .join(',')}; frame=${lastFrame() ?? ''}`,
  );
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.length === 0);

  expect(controller.getSnapshot().editor.text).toBe('before mock/path after');
  expect(controller.getSnapshot().editor.cursor).toBe('before mock/path '.length);
});

it.sequential('accepting /settings opens the settings successor menu', async () => {
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(controller, [...slashCommands, settingsCommand]);

  await writeInput(stdin, '/settings');
  await waitFor(() => (lastFrame() ?? '').includes('/settings'));
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings');

  expect(controller.getSnapshot().editor.text).toBe('/settings ');
  expect(lastFrame()).toContain('Use ↑↓ to navigate, Enter to edit, Esc to close');
});

it.sequential('accepting a /settings prefix opens the settings successor menu', async () => {
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(controller, [...slashCommands, settingsCommand]);

  await writeInput(stdin, '/sett');
  await waitFor(() => (lastFrame() ?? '').includes('/settings'));
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings');

  expect(controller.getSnapshot().editor.text).toBe('/settings ');
  expect(lastFrame()).toContain('Use ↑↓ to navigate, Enter to edit, Esc to close');
});

it.sequential('typing the /settings autocomplete trigger opens the settings menu', async () => {
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(controller, [...slashCommands, settingsCommand]);

  await writeInput(stdin, '/settings ');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings');

  expect(controller.getSnapshot().editor.text).toBe('/settings ');
  expect(lastFrame()).toContain('Use ↑↓ to navigate, Enter to edit, Esc to close');
});

it.sequential('shows the typed settings query above the filtered menu', async () => {
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(controller, [...slashCommands, settingsCommand]);

  await writeInput(stdin, '/settings shell.time');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings');

  expect(lastFrame()).toContain('Filter: shell.time');
});

it.sequential('Escape from the root settings menu clears the slash command buffer', async () => {
  const controller = new MenuControllerImpl();
  const { stdin } = await renderSurface(controller, [...slashCommands, settingsCommand]);

  await writeInput(stdin, '/settings ');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings');

  await writeInput(stdin, '\u001b');
  await waitFor(() => controller.getSnapshot().stack.length === 0);

  expect(controller.getSnapshot().editor).toMatchObject({ text: '', cursor: 0 });
});

it.sequential(
  'Escape returns from a settings value child to its filtered parent through the terminal boundary',
  async () => {
    const controller = new MenuControllerImpl();
    const { stdin } = await renderSurface(controller, [...slashCommands, settingsCommand]);

    await writeInput(stdin, '/settings shell.time');
    await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings');
    await writeInput(stdin, '\r');
    await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings_value');

    await writeInput(stdin, '\u001b');
    await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings');

    expect(controller.getSnapshot().editor).toMatchObject({ text: '/settings shell.time', cursor: 20 });
  },
);

it.sequential('opens the mentor pool editor without repeatedly updating the controller store', async () => {
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(controller, [...slashCommands, settingsCommand]);

  await writeInput(stdin, '/settings agent.mentorPool');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings');

  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'mentor_pool');
  await settle();

  expect(lastFrame()).toContain('Mentor Pool');
  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('mentor_pool');
});

it.sequential('accepting a /model prefix opens the model successor menu', async () => {
  const controller = new MenuControllerImpl();
  const { stdin } = await renderSurface(controller, [...slashCommands, modelCommand]);

  await writeInput(stdin, '/mod');
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'model');

  expect(controller.getSnapshot().editor.text).toBe('/model ');
});

it.sequential('accepting a /skills prefix opens the skills successor menu', async () => {
  const controller = new MenuControllerImpl();
  const { stdin } = await renderSurface(controller, [...slashCommands, skillsCommand]);

  await writeInput(stdin, '/ski');
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'skills');

  expect(controller.getSnapshot().editor.text).toBe('/skills ');
});

it.sequential('accepting a skill activates it immediately and clears the command buffer', async () => {
  const skill: SkillInfo = {
    name: 'codebase-design',
    description: 'Design deep modules',
    location: '/skills/codebase-design/SKILL.md',
    isProjectLevel: true,
    body: 'Use deep modules.',
    rawContent: '---\nname: codebase-design\n---\nUse deep modules.',
  };
  const onSkillSelected = vi.fn();
  const onSystemMessage = vi.fn();
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(controller, [...slashCommands, skillsCommand], undefined, {
    skillsService: { getAvailableSkills: () => [skill] } as SkillsService,
    onSkillSelected,
    onSystemMessage,
  });

  await writeInput(stdin, '/skills ');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'skills');
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.length === 0);

  expect(onSkillSelected).toHaveBeenCalledWith(skill);
  expect(onSystemMessage).toHaveBeenCalledWith(
    'Skill "codebase-design" activated. Type your request (or press Esc to cancel).',
  );
  expect(controller.getSnapshot().editor).toMatchObject({ text: '', cursor: 0 });
  expect(lastFrame()).not.toContain('/skills');
});

it.sequential('accepting a /auto-approve prefix opens the auto-approve value successor menu', async () => {
  const controller = new MenuControllerImpl();
  const { stdin } = await renderSurface(controller, [...slashCommands, autoApproveCommand]);

  await writeInput(stdin, '/auto-app');
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'settings_value');

  expect(controller.getSnapshot().editor.text).toBe('/auto-approve ');
  expect(controller.getSnapshot().stack.at(-1)).toMatchObject({
    kind: 'settings_value',
    settingKey: 'shell.autoApproveMode',
  });
});

it.sequential('accepting a /profile prefix opens the profile successor menu', async () => {
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(controller, [...slashCommands, profileCommand]);

  await writeInput(stdin, '/prof');
  await waitFor(() => (lastFrame() ?? '').includes('/profile'));
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'profile');

  expect(controller.getSnapshot().editor.text).toBe('/profile ');
});

it.sequential('typing the /profile autocomplete trigger opens the profile menu', async () => {
  const controller = new MenuControllerImpl();
  const { stdin } = await renderSurface(controller, [...slashCommands, profileCommand]);

  await writeInput(stdin, '/profile ');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'profile');

  expect(controller.getSnapshot().editor.text).toBe('/profile ');
});

it.sequential('accepting a /resume prefix opens the resume successor menu', async () => {
  const controller = new MenuControllerImpl();
  const { stdin } = await renderSurface(controller, [...slashCommands, resumeCommand]);

  await writeInput(stdin, '/res');
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'resume');

  expect(controller.getSnapshot().editor.text).toBe('/resume ');
});

it.sequential('accepting a conversation from /resume resumes it and clears the buffer', async () => {
  const resumeConversation = vi.fn(async () => {});
  const controller = new MenuControllerImpl();
  const { lastFrame, stdin } = await renderSurface(controller, [...slashCommands, resumeCommand], undefined, {
    listConversations: () => [
      { id: 'session-abc-123', updatedAt: '2026-08-30T12:00:00.000Z', firstUserMessage: 'Test task' },
    ],
    resumeConversation,
  });

  await writeInput(stdin, '/resume ');
  await waitFor(() => controller.getSnapshot().stack.at(-1)?.kind === 'resume');
  await writeInput(stdin, '\r');
  await waitFor(() => controller.getSnapshot().stack.length === 0);

  expect(resumeConversation).toHaveBeenCalledWith('session-abc-123');
  expect(controller.getSnapshot().editor).toMatchObject({ text: '', cursor: 0 });
  expect(lastFrame()).not.toContain('/resume');
});
