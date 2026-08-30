import type { SlashCommand } from '../../slash-commands.js';
import { TriggerRuleRegistry } from './menu-controller.js';
import { determineActiveMenu } from './determine-active-menu.js';
import { getModelSettingConfigForInput } from '../../utils/ai/model-settings.js';
import { SETTING_KEYS } from '../../services/settings/settings-service.js';

export const STOP_CHAR_REGEX = /[\s,;:()[\]{}<>]/;
export const SETTINGS_TRIGGER = '/settings ';
export const SETTINGS_RESET_TRIGGER = '/settings reset ';
export const AUTO_APPROVE_TRIGGER = '/auto-approve ';
export const EFFORT_TRIGGER = '/effort ';
export const SKILLS_TRIGGER = '/skills ';
export const RESUME_TRIGGER = '/resume ';

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

// A passively-typed successor (the user typed the whole trigger themselves,
// rather than accepting a highlighted item from a mounted settings list) has
// no prior parent-frame state to preserve — there was never a mounted
// `SettingsMenuSession` filtering a list for this activation. Its Back
// therefore restores to the bare, unfiltered settings prefix rather than
// reconstructing "what the user had typed before this". This matches the
// pre-existing default (`settingsFilterRef` started at `''` and was only
// ever populated by an explicit list selection).
const settingsListRestorePoint = (revision: number) => ({
  editor: { text: SETTINGS_TRIGGER, cursor: SETTINGS_TRIGGER.length, revision },
});

export function createDefaultTriggerRegistry(
  slashCommands: SlashCommand[] = [],
  enabledRuleIds?: readonly string[],
): TriggerRuleRegistry {
  const registry = new TriggerRuleRegistry();
  const enabled = enabledRuleIds ? new Set(enabledRuleIds) : undefined;
  const registerRule = (rule: Parameters<TriggerRuleRegistry['registerRule']>[0]) => {
    if (!enabled || enabled.has(rule.id)) registry.registerRule(rule);
  };

  // Priority 50: settings-backed model selection (graph 3 — `/settings
  // agent.model ` via MODEL_SETTING_TRIGGERS). Its Back target is the setting
  // it came from, restoring the settings list rather than clearing input.
  registerRule({
    id: 'settings-model',
    priority: 50,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'model' && active.origin === 'settings-backed') {
        const config = getModelSettingConfigForInput(editor.text);
        if (!config) return null;
        return {
          ruleId: 'settings-model',
          identity: `settings-model:${active.startIndex}`,
          frame: {
            kind: 'model',
            target: {
              type: 'setting',
              config: {
                modelKey: config.modelKey,
                providerKey: config.providerKey,
                fallbackProviderKey: config.fallbackProviderKey,
              },
            },
            back: { type: 'restore', point: settingsListRestorePoint(editor.revision) },
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

  // Priority 50: direct command-backed model selection (graph 4 — `/model `).
  // Disabled until Step 2 enables `command-model`.
  registerRule({
    id: 'command-model',
    priority: 50,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'model' && active.origin === 'direct-trigger') {
        return {
          ruleId: 'command-model',
          identity: `command-model:${active.startIndex}`,
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

  // Priority 40: the `/settings <key> ` value child (graph 3). Reached as a
  // declared successor of `settings` when a key selection or manually typed
  // key completes, and also parses standalone so a fully-typed
  // `/settings <key> ` opens directly. Its Back restores the settings list.
  registerRule({
    id: 'settings-value-child',
    priority: 40,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'settings_value' && active.origin === 'settings-list') {
        return {
          ruleId: 'settings-value-child',
          identity: `settings-value-child:${active.key}:${active.startIndex}`,
          frame: {
            kind: 'settings_value',
            settingKey: active.key,
            origin: {
              type: 'settings-list',
              operation: 'set',
              back: { type: 'restore', point: settingsListRestorePoint(editor.revision) },
            },
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

  registerRule({
    id: 'settings-mentor-pool-child',
    priority: 45,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (
        active.type !== 'settings_value' ||
        active.origin !== 'settings-list' ||
        active.key !== SETTING_KEYS.AGENT_MENTOR_POOL
      ) {
        return null;
      }
      return {
        ruleId: 'settings-mentor-pool-child',
        identity: `settings-mentor-pool-child:${active.startIndex}`,
        frame: {
          kind: 'mentor_pool' as const,
          origin: {
            type: 'settings-list' as const,
            operation: 'set' as const,
            back: { type: 'restore' as const, point: settingsListRestorePoint(editor.revision) },
          },
          binding: {
            trigger: { range: { start: 0, end: active.startIndex }, text: editor.text.slice(0, active.startIndex) },
            queryStart: active.startIndex,
            queryEnd: 'cursor' as const,
            replacement: { start: active.startIndex, end: 'buffer-end' as const },
          },
        },
      };
    },
    successors: [],
  });

  // Priority 40: direct setting-value triggers (graph 4 — `/effort `,
  // `/auto-approve `). Disabled until Step 2 enables `direct-setting-value`.
  registerRule({
    id: 'direct-setting-value',
    priority: 40,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'settings_value' && active.origin === 'direct-trigger') {
        return {
          ruleId: 'direct-setting-value',
          identity: `direct-setting-value:${active.key}:${active.startIndex}`,
          frame: {
            kind: 'settings_value',
            settingKey: active.key,
            origin: { type: 'direct-trigger', triggerId: active.key, back: { type: 'close-clear-input' } },
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

  // Priority 30: Settings (`/settings `, `/settings reset `).
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
      { ruleId: 'settings-value-child', operation: 'push' },
      { ruleId: 'settings-mentor-pool-child', operation: 'push' },
      { ruleId: 'settings-model', operation: 'push' },
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

  // Priority 20: Resume
  registerRule({
    id: 'resume',
    priority: 20,
    parse: (editor) => {
      const active = determineActiveMenu(editor.text, editor.cursor, slashCommands);
      if (active.type === 'resume') {
        return {
          ruleId: 'resume',
          identity: 'resume-root',
          frame: {
            kind: 'resume',
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
