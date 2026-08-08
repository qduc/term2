import type { SlashCommand } from '../../slash-commands.js';
import { TriggerRuleRegistry } from './menu-controller.js';
import { determineActiveMenu } from './determine-active-menu.js';

export const STOP_CHAR_REGEX = /[\s,;:()[\]{}<>]/;
export const SETTINGS_TRIGGER = '/settings ';
export const SETTINGS_RESET_TRIGGER = '/settings reset ';
export const AUTO_APPROVE_TRIGGER = '/auto-approve ';
export const EFFORT_TRIGGER = '/effort ';
export const SKILLS_TRIGGER = '/skills ';

const whitespaceRegex = /\s/;

export const findPathTrigger = (
  text: string,
  cursor: number,
  stopChars: RegExp = STOP_CHAR_REGEX,
): { start: number; query: string } | null => {
  if (cursor <= 0 || cursor > text.length) {
    return null;
  }

  for (let index = cursor - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '@') {
      const query = text.slice(index + 1, cursor);
      if (whitespaceRegex.test(query)) {
        return null;
      }
      return { start: index, query };
    }
    if (stopChars.test(char)) {
      break;
    }
  }

  return null;
};

export function createDefaultTriggerRegistry(
  slashCommands: SlashCommand[] = [],
  enabledRuleIds?: readonly string[],
): TriggerRuleRegistry {
  const registry = new TriggerRuleRegistry();
  const enabled = enabledRuleIds ? new Set(enabledRuleIds) : undefined;
  const registerRule = (rule: Parameters<TriggerRuleRegistry['registerRule']>[0]) => {
    if (!enabled || enabled.has(rule.id)) registry.registerRule(rule);
  };

  // Priority 50: Model selection
  registerRule({
    id: 'model',
    priority: 50,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'model') {
        return {
          ruleId: 'model',
          identity: `model:${active.startIndex}`,
          frame: {
            kind: 'model',
            target: { type: 'command' },
            back: { type: 'close-clear-input' },
            binding: {
              trigger: { range: { start: 0, end: active.startIndex }, text: editor.text.slice(0, active.startIndex) },
              queryStart: active.startIndex,
              queryEnd: 'cursor',
              replacement: { start: active.startIndex, end: 'buffer-end' },
            },
          },
        };
      }
      return null;
    },
    successors: [],
  });

  // Priority 40: Settings value
  registerRule({
    id: 'settings_value',
    priority: 40,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'settings_value') {
        return {
          ruleId: 'settings_value',
          identity: `settings_value:${active.key}:${active.startIndex}`,
          frame: {
            kind: 'settings_value',
            settingKey: active.key,
            origin: { type: 'direct-trigger', triggerId: 'settings_value', back: { type: 'close-clear-input' } },
            binding: {
              trigger: { range: { start: 0, end: active.startIndex }, text: editor.text.slice(0, active.startIndex) },
              queryStart: active.startIndex,
              queryEnd: 'cursor',
              replacement: { start: active.startIndex, end: 'cursor' },
            },
          },
        };
      }
      return null;
    },
    successors: [],
  });

  // Priority 30: Settings
  registerRule({
    id: 'settings',
    priority: 30,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'settings') {
        const isReset = editor.text.startsWith('/settings reset ');
        return {
          ruleId: 'settings',
          identity: `settings:${isReset ? 'reset' : 'set'}`,
          frame: {
            kind: 'settings',
            operation: isReset ? 'reset' : 'set',
            prefix: isReset ? '/settings reset ' : '/settings ',
            binding: {
              trigger: { range: { start: 0, end: active.startIndex }, text: editor.text.slice(0, active.startIndex) },
              queryStart: active.startIndex,
              queryEnd: 'cursor',
              replacement: { start: active.startIndex, end: 'buffer-end' },
            },
          },
        };
      }
      return null;
    },
    successors: [
      { ruleId: 'settings_value', operation: 'push' },
      { ruleId: 'model', operation: 'push' },
    ],
  });

  // Priority 20: Skills
  registerRule({
    id: 'skills',
    priority: 20,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'skills') {
        return {
          ruleId: 'skills',
          identity: 'skills-root',
          frame: {
            kind: 'skills',
            binding: {
              trigger: { range: { start: 0, end: active.startIndex }, text: editor.text.slice(0, active.startIndex) },
              queryStart: active.startIndex,
              queryEnd: 'cursor',
              replacement: { start: active.startIndex, end: 'cursor' },
            },
          },
        };
      }
      return null;
    },
    successors: [],
  });

  // Priority 10: Slash
  registerRule({
    id: 'slash',
    priority: 10,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'slash') {
        return {
          ruleId: 'slash',
          identity: 'slash-root',
          frame: {
            kind: 'slash',
            binding: {
              trigger: { range: { start: 0, end: 1 }, text: '/' },
              queryStart: 1,
              queryEnd: 'cursor',
              replacement: { start: 0, end: 'cursor' },
            },
          },
        };
      }
      return null;
    },
    successors: [],
  });

  // Priority 5: Path
  registerRule({
    id: 'path',
    priority: 5,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'path') {
        return {
          ruleId: 'path',
          identity: `path:${active.trigger.start}`,
          frame: {
            kind: 'path',
            binding: {
              trigger: { range: { start: active.trigger.start, end: active.trigger.start + 1 }, text: '@' },
              queryStart: active.trigger.start + 1,
              queryEnd: 'cursor',
              replacement: { start: active.trigger.start, end: 'cursor' },
            },
          },
        };
      }
      return null;
    },
    successors: [],
  });

  return registry;
}
