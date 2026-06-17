import { it, expect } from 'vitest';
import { findPathTrigger } from './input/triggers.js';
import { determineActiveMenu, type ActiveMenu } from './input/determine-active-menu.js';
import type { SlashCommand } from '../slash-commands.js';
import {
  MODEL_TRIGGER,
  MENTOR_TRIGGER,
  AUTO_APPROVE_MODEL_TRIGGER,
  EDIT_HEALING_MODEL_TRIGGER,
  SUBAGENT_EXPLORER_MODEL_TRIGGER,
  SUBAGENT_WORKER_MODEL_TRIGGER,
  SUBAGENT_RESEARCHER_MODEL_TRIGGER,
} from '../hooks/use-model-selection.js';

const commandMetadata: SlashCommand[] = [
  {
    name: 'model',
    description: 'Change model',
    expectsArgs: true,
    completion: { type: 'model', trigger: '/model ' },
    action: () => {},
  },
  {
    name: 'settings',
    description: 'Settings',
    expectsArgs: true,
    completion: { type: 'settings', trigger: '/settings ', resetTrigger: '/settings reset ' },
    action: () => {},
  },
  {
    name: 'auto-approve',
    description: 'Shell approval',
    expectsArgs: true,
    completion: { type: 'setting-value', trigger: '/auto-approve ', settingKey: 'shell.autoApproveMode' },
    action: () => {},
  },
];

const determine = (input: string, cursor = input.length) => determineActiveMenu(input, cursor, commandMetadata);

it('determineActiveMenu - model triggers (priority 0)', () => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    {
      input: '/settings agent.model gpt-4',
      cursor: '/settings agent.model gpt-4'.length,
      expected: { type: 'model', startIndex: MODEL_TRIGGER.length },
    },
    {
      input: '/model gpt',
      cursor: '/model gpt'.length,
      expected: { type: 'model', startIndex: '/model '.length },
    },
    {
      input: '/settings agent.mentorModel claude',
      cursor: '/settings agent.mentorModel claude'.length,
      expected: { type: 'model', startIndex: MENTOR_TRIGGER.length },
    },
    {
      input: '/settings agent.autoApproveModel haiku',
      cursor: '/settings agent.autoApproveModel haiku'.length,
      expected: { type: 'model', startIndex: AUTO_APPROVE_MODEL_TRIGGER.length },
    },
    {
      input: '/settings tools.editHealingModel gpt-4o-mini',
      cursor: '/settings tools.editHealingModel gpt-4o-mini'.length,
      expected: { type: 'model', startIndex: EDIT_HEALING_MODEL_TRIGGER.length },
    },
    {
      input: '/settings agent.subagentExplorerModel gpt-4o',
      cursor: '/settings agent.subagentExplorerModel gpt-4o'.length,
      expected: { type: 'model', startIndex: SUBAGENT_EXPLORER_MODEL_TRIGGER.length },
    },
    {
      input: '/settings agent.subagentWorkerModel gpt-4o',
      cursor: '/settings agent.subagentWorkerModel gpt-4o'.length,
      expected: { type: 'model', startIndex: SUBAGENT_WORKER_MODEL_TRIGGER.length },
    },
    {
      input: '/settings agent.subagentResearcherModel gpt-4o',
      cursor: '/settings agent.subagentResearcherModel gpt-4o'.length,
      expected: { type: 'model', startIndex: SUBAGENT_RESEARCHER_MODEL_TRIGGER.length },
    },
  ];

  for (const { input, cursor, expected } of cases) {
    expect(determine(input, cursor), `Failed for input: "${input}"`).toEqual(expected);
  }
});

it('determineActiveMenu - settings menu (priority 1)', () => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    { input: '/settings ', cursor: 10, expected: { type: 'settings', startIndex: 10 } },
    { input: '/settings ag', cursor: 12, expected: { type: 'settings', startIndex: 10 } },
    {
      input: '/settings agent.theme',
      cursor: '/settings agent.theme'.length,
      expected: { type: 'settings', startIndex: 10 },
    },
  ];

  for (const { input, cursor, expected } of cases) {
    expect(determine(input, cursor), `Failed for input: "${input}"`).toEqual(expected);
  }
});

it('determineActiveMenu - settings reset variant', () => {
  const reset = '/settings reset ';
  expect(determine(reset)).toEqual({ type: 'settings', startIndex: reset.length });
  expect(determine(`${reset}log`)).toEqual({
    type: 'settings',
    startIndex: reset.length,
  });
});

it('determineActiveMenu - settings_value transition (key + space)', () => {
  // Generic key, not a model trigger.
  const input = '/settings logging.logLevel ';
  expect(determine(input)).toEqual({
    type: 'settings_value',
    key: 'logging.logLevel',
    startIndex: input.length,
  });
});

it('determineActiveMenu - auto-approve trigger maps to settings_value', () => {
  const input = '/auto-approve ';
  expect(determine(input)).toEqual({
    type: 'settings_value',
    key: 'shell.autoApproveMode',
    startIndex: input.length,
  });
});

it('determineActiveMenu - slash menu (priority 2)', () => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    { input: '/', cursor: 1, expected: { type: 'slash' } },
    { input: '/mod', cursor: 4, expected: { type: 'slash' } },
    { input: '/clear', cursor: 6, expected: { type: 'slash' } },
  ];

  for (const { input, cursor, expected } of cases) {
    expect(determine(input, cursor), `Failed for input: "${input}"`).toEqual(expected);
  }
});

it('determineActiveMenu - path menu (priority 3)', () => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    { input: '@', cursor: 1, expected: { type: 'path', trigger: { start: 0, query: '' } } },
    { input: '@src', cursor: 4, expected: { type: 'path', trigger: { start: 0, query: 'src' } } },
    {
      input: 'check @src/app',
      cursor: 14,
      expected: { type: 'path', trigger: { start: 6, query: 'src/app' } },
    },
  ];

  for (const { input, cursor, expected } of cases) {
    expect(determine(input, cursor), `Failed for input: "${input}"`).toEqual(expected);
  }
});

it('determineActiveMenu - none', () => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    { input: '', cursor: 0, expected: { type: 'none' } },
    { input: 'hello world', cursor: 11, expected: { type: 'none' } },
    { input: 'test', cursor: 4, expected: { type: 'none' } },
  ];

  for (const { input, cursor, expected } of cases) {
    expect(determine(input, cursor), `Failed for input: "${input}"`).toEqual(expected);
  }
});

it('determineActiveMenu - priority enforcement', () => {
  // Settings beats slash.
  expect(determine('/settings ', 10)).toEqual({ type: 'settings', startIndex: 10 });

  // Model beats settings when model trigger fully present.
  expect(determine('/settings agent.model ', MODEL_TRIGGER.length)).toEqual({
    type: 'model',
    startIndex: MODEL_TRIGGER.length,
  });

  // Slash beats path: "/@test" stays slash.
  expect(determine('/@test', 6)).toEqual({ type: 'slash' });
});

it('determineActiveMenu - static setting-value commands come from command metadata', () => {
  const commands: SlashCommand[] = [
    {
      name: 'theme-mode',
      description: 'Set theme mode',
      expectsArgs: true,
      completion: { type: 'setting-value', trigger: '/theme-mode ', settingKey: 'ui.theme' },
      action: () => {},
    },
  ];

  expect(determineActiveMenu('/theme-mode ', '/theme-mode '.length, commands)).toEqual({
    type: 'settings_value',
    key: 'ui.theme',
    startIndex: '/theme-mode '.length,
  });
});

it('determineActiveMenu - cursor not yet past trigger returns none', () => {
  // value contains "/settings " but cursor is mid-trigger; cursor < trigger.length and the trailing
  // space disqualifies slash too, so no menu activates.
  expect(determine('/settings ', 5)).toEqual({ type: 'none' });
});

it('findPathTrigger - basic behavior preserved', () => {
  expect(findPathTrigger('@', 1)).toEqual({ start: 0, query: '' });
  expect(findPathTrigger('@src/app', 8)).toEqual({ start: 0, query: 'src/app' });
  expect(findPathTrigger('hello', 5)).toBe(null);
  // Whitespace inside the query invalidates the trigger.
  expect(findPathTrigger('@foo bar', 8)).toBe(null);
});
