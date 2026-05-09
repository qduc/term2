import {
  MODEL_TRIGGER,
  MENTOR_TRIGGER,
  AUTO_APPROVE_MODEL_TRIGGER,
  EDIT_HEALING_MODEL_TRIGGER,
} from '../../hooks/use-model-selection.js';
import type { SlashCommand, SlashCommandCompletion } from '../../slash-commands.js';
import { findPathTrigger } from './triggers.js';

const MODEL_SETTING_TRIGGERS = [
  MODEL_TRIGGER,
  MENTOR_TRIGGER,
  AUTO_APPROVE_MODEL_TRIGGER,
  EDIT_HEALING_MODEL_TRIGGER,
] as const;

export type ActiveMenu =
  | { type: 'none' }
  | { type: 'slash' }
  | { type: 'settings'; startIndex: number }
  | { type: 'settings_value'; key: string; startIndex: number }
  | { type: 'model'; startIndex: number }
  | { type: 'path'; trigger: { start: number; query: string } };

const hasCompletion = (completion: SlashCommandCompletion | undefined): completion is SlashCommandCompletion =>
  completion !== undefined;

const getCommandCompletions = (commands: SlashCommand[] = []) =>
  commands.map((command) => command.completion).filter(hasCompletion);

export const determineActiveMenu = (value: string, cursorOffset: number, commands: SlashCommand[] = []): ActiveMenu => {
  const commandCompletions = getCommandCompletions(commands);

  // Priority 0: model selection. Settings-backed model keys stay in model-settings;
  // command-backed model triggers are declared on slash commands.
  const commandModelTriggers = commandCompletions
    .filter((completion) => completion.type === 'model')
    .map((completion) => completion.trigger);
  for (const trigger of [...MODEL_SETTING_TRIGGERS, ...commandModelTriggers]) {
    if (value.startsWith(trigger) && cursorOffset >= trigger.length) {
      return { type: 'model', startIndex: trigger.length };
    }
  }

  // Priority 1: settings (reset variant first because it's a prefix-extension),
  // then static setting-value command triggers.
  for (const completion of commandCompletions) {
    if (completion.type !== 'settings') continue;

    if (value.startsWith(completion.resetTrigger)) {
      if (cursorOffset >= completion.resetTrigger.length) {
        return { type: 'settings', startIndex: completion.resetTrigger.length };
      }
      continue;
    }

    if (value.startsWith(completion.trigger)) {
      const end = Math.min(cursorOffset, value.length);
      const afterPrefix = value.slice(completion.trigger.length, end);
      const keyAndSpaceMatch = afterPrefix.match(/^(\S+)\s+/);
      if (keyAndSpaceMatch) {
        const key = keyAndSpaceMatch[1] ?? '';
        const startIndex = completion.trigger.length + (keyAndSpaceMatch[0]?.length ?? 0);
        return { type: 'settings_value', key, startIndex };
      }
      if (cursorOffset >= completion.trigger.length) {
        return { type: 'settings', startIndex: completion.trigger.length };
      }
    }
  }

  for (const completion of commandCompletions) {
    if (completion.type !== 'setting-value') continue;
    if (value.startsWith(completion.trigger) && cursorOffset >= completion.trigger.length) {
      return {
        type: 'settings_value',
        key: completion.settingKey,
        startIndex: completion.trigger.length,
      };
    }
  }

  // Priority 2: slash command (only when no space typed yet and cursor has moved past '/').
  if (value.startsWith('/') && !value.slice(1).includes(' ') && cursorOffset > 0) {
    return { type: 'slash' };
  }

  // Priority 3: @path completion.
  const pathTrigger = findPathTrigger(value, cursorOffset);
  if (pathTrigger) {
    return { type: 'path', trigger: pathTrigger };
  }

  return { type: 'none' };
};
