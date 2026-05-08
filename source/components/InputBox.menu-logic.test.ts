import test from 'ava';
import { findPathTrigger } from './Input/triggers.js';
import { determineActiveMenu, type ActiveMenu } from './Input/determine-active-menu.js';
import {
  MODEL_TRIGGER,
  MODEL_CMD_TRIGGER,
  MENTOR_TRIGGER,
  AUTO_APPROVE_MODEL_TRIGGER,
  EDIT_HEALING_MODEL_TRIGGER,
} from '../hooks/use-model-selection.js';

test('determineActiveMenu - model triggers (priority 0)', (t) => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    {
      input: '/settings agent.model gpt-4',
      cursor: '/settings agent.model gpt-4'.length,
      expected: { type: 'model', startIndex: MODEL_TRIGGER.length },
    },
    {
      input: '/model gpt',
      cursor: '/model gpt'.length,
      expected: { type: 'model', startIndex: MODEL_CMD_TRIGGER.length },
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
  ];

  for (const { input, cursor, expected } of cases) {
    t.deepEqual(determineActiveMenu(input, cursor), expected, `Failed for input: "${input}"`);
  }
});

test('determineActiveMenu - settings menu (priority 1)', (t) => {
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
    t.deepEqual(determineActiveMenu(input, cursor), expected, `Failed for input: "${input}"`);
  }
});

test('determineActiveMenu - settings reset variant', (t) => {
  const reset = '/settings reset ';
  t.deepEqual(determineActiveMenu(reset, reset.length), { type: 'settings', startIndex: reset.length });
  t.deepEqual(determineActiveMenu(`${reset}log`, `${reset}log`.length), {
    type: 'settings',
    startIndex: reset.length,
  });
});

test('determineActiveMenu - settings_value transition (key + space)', (t) => {
  // Generic key, not a model trigger.
  const input = '/settings logging.logLevel ';
  t.deepEqual(determineActiveMenu(input, input.length), {
    type: 'settings_value',
    key: 'logging.logLevel',
    startIndex: input.length,
  });
});

test('determineActiveMenu - auto-approve trigger maps to settings_value', (t) => {
  const input = '/auto-approve ';
  t.deepEqual(determineActiveMenu(input, input.length), {
    type: 'settings_value',
    key: 'shell.autoApproveMode',
    startIndex: input.length,
  });
});

test('determineActiveMenu - slash menu (priority 2)', (t) => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    { input: '/', cursor: 1, expected: { type: 'slash' } },
    { input: '/mod', cursor: 4, expected: { type: 'slash' } },
    { input: '/clear', cursor: 6, expected: { type: 'slash' } },
  ];

  for (const { input, cursor, expected } of cases) {
    t.deepEqual(determineActiveMenu(input, cursor), expected, `Failed for input: "${input}"`);
  }
});

test('determineActiveMenu - path menu (priority 3)', (t) => {
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
    t.deepEqual(determineActiveMenu(input, cursor), expected, `Failed for input: "${input}"`);
  }
});

test('determineActiveMenu - none', (t) => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    { input: '', cursor: 0, expected: { type: 'none' } },
    { input: 'hello world', cursor: 11, expected: { type: 'none' } },
    { input: 'test', cursor: 4, expected: { type: 'none' } },
  ];

  for (const { input, cursor, expected } of cases) {
    t.deepEqual(determineActiveMenu(input, cursor), expected, `Failed for input: "${input}"`);
  }
});

test('determineActiveMenu - priority enforcement', (t) => {
  // Settings beats slash.
  t.deepEqual(determineActiveMenu('/settings ', 10), { type: 'settings', startIndex: 10 });

  // Model beats settings when model trigger fully present.
  t.deepEqual(determineActiveMenu('/settings agent.model ', MODEL_TRIGGER.length), {
    type: 'model',
    startIndex: MODEL_TRIGGER.length,
  });

  // Slash beats path: "/@test" stays slash.
  t.deepEqual(determineActiveMenu('/@test', 6), { type: 'slash' });
});

test('determineActiveMenu - cursor not yet past trigger returns none', (t) => {
  // value contains "/settings " but cursor is mid-trigger; cursor < trigger.length and the trailing
  // space disqualifies slash too, so no menu activates.
  t.deepEqual(determineActiveMenu('/settings ', 5), { type: 'none' });
});

test('findPathTrigger - basic behavior preserved', (t) => {
  t.deepEqual(findPathTrigger('@', 1), { start: 0, query: '' });
  t.deepEqual(findPathTrigger('@src/app', 8), { start: 0, query: 'src/app' });
  t.is(findPathTrigger('hello', 5), null);
  // Whitespace inside the query invalidates the trigger.
  t.is(findPathTrigger('@foo bar', 8), null);
});
