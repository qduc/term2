import { MODEL_SETTING_TRIGGERS } from '../../utils/ai/model-settings.js';
import type { SlashCommand, SlashCommandCompletion } from '../../slash-commands.js';
import { findPathTrigger } from './triggers.js';

// `origin` distinguishes graph 3 (settings-backed, reached through the
// mounted `/settings ` list) from graph 4 (a direct top-level trigger such as
// `/model `, `/effort `, `/auto-approve `). Both graphs currently share this
// detection function, but the controller may only own one graph's rule ids at
// a time (see the Phase 4 rule-id collision note in the menu redesign plan),
// so callers that build controller trigger rules must branch on `origin`
// rather than merging the two graphs back together.
export type ActiveMenu =
  | { type: 'none' }
  | { type: 'slash' }
  | { type: 'settings'; startIndex: number }
  | { type: 'settings_value'; key: string; startIndex: number; origin: 'settings-list' | 'direct-trigger' }
  | { type: 'model'; startIndex: number; origin: 'settings-backed' | 'direct-trigger' }
  | { type: 'skills'; startIndex: number }
  | { type: 'resume'; startIndex: number }
  | { type: 'path'; trigger: { start: number; query: string } };

const hasCompletion = (completion: SlashCommandCompletion | undefined): completion is SlashCommandCompletion =>
  completion !== undefined;

const getCommandCompletions = (commands: SlashCommand[] = []) =>
  commands.map((command) => command.completion).filter(hasCompletion);

export const determineActiveMenu = (value: string, cursorOffset: number, commands: SlashCommand[] = []): ActiveMenu => {
  const commandCompletions = getCommandCompletions(commands);

  // Priority 0: model selection. Settings-backed model keys stay in model-settings;
  // command-backed model triggers are declared on slash commands. The two
  // loops preserve the original combined-array iteration order (settings-
  // backed triggers win ties) while tagging which graph the match belongs to.
  const commandModelTriggers = commandCompletions
    .filter((completion) => completion.type === 'model')
    .map((completion) => completion.trigger);
  for (const trigger of MODEL_SETTING_TRIGGERS) {
    if (value.startsWith(trigger) && cursorOffset >= trigger.length) {
      return { type: 'model', startIndex: trigger.length, origin: 'settings-backed' };
    }
  }
  for (const trigger of commandModelTriggers) {
    if (value.startsWith(trigger) && cursorOffset >= trigger.length) {
      return { type: 'model', startIndex: trigger.length, origin: 'direct-trigger' };
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
        return { type: 'settings_value', key, startIndex, origin: 'settings-list' };
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
        origin: 'direct-trigger',
      };
    }
  }

  // Priority 2: skills and resume selection (after settings triggers, before slash).
  for (const completion of commandCompletions) {
    if (completion.type === 'skills') {
      if (value.startsWith(completion.trigger) && cursorOffset >= completion.trigger.length) {
        return { type: 'skills', startIndex: completion.trigger.length };
      }
    } else if (completion.type === 'resume') {
      if (value.startsWith(completion.trigger) && cursorOffset >= completion.trigger.length) {
        return { type: 'resume', startIndex: completion.trigger.length };
      }
    }
  }

  // Priority 3: slash command (only when no space typed yet and cursor has moved past '/').
  if (value.startsWith('/') && !value.slice(1).includes(' ') && cursorOffset > 0) {
    return { type: 'slash' };
  }

  // Priority 4: @path completion.
  const pathTrigger = findPathTrigger(value, cursorOffset);
  if (pathTrigger) {
    return { type: 'path', trigger: pathTrigger };
  }

  return { type: 'none' };
};
