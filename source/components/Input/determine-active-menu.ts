import {
  MODEL_TRIGGER,
  MODEL_CMD_TRIGGER,
  MENTOR_TRIGGER,
  AUTO_APPROVE_MODEL_TRIGGER,
  EDIT_HEALING_MODEL_TRIGGER,
} from '../../hooks/use-model-selection.js';
import { SETTINGS_TRIGGER, SETTINGS_RESET_TRIGGER, AUTO_APPROVE_TRIGGER, findPathTrigger } from './triggers.js';

const MODEL_TRIGGERS = [
  MODEL_TRIGGER,
  MODEL_CMD_TRIGGER,
  MENTOR_TRIGGER,
  AUTO_APPROVE_MODEL_TRIGGER,
  EDIT_HEALING_MODEL_TRIGGER,
] as const;

const AUTO_APPROVE_SETTING_KEY = 'shell.autoApproveMode';

export type ActiveMenu =
  | { type: 'none' }
  | { type: 'slash' }
  | { type: 'settings'; startIndex: number }
  | { type: 'settings_value'; key: string; startIndex: number }
  | { type: 'model'; startIndex: number }
  | { type: 'path'; trigger: { start: number; query: string } };

export const determineActiveMenu = (value: string, cursorOffset: number): ActiveMenu => {
  // Priority 0: model selection (4 triggers).
  for (const trigger of MODEL_TRIGGERS) {
    if (value.startsWith(trigger) && cursorOffset >= trigger.length) {
      return { type: 'model', startIndex: trigger.length };
    }
  }

  // Priority 1: settings (reset variant first because it's a prefix-extension), then auto-approve.
  if (value.startsWith(SETTINGS_RESET_TRIGGER)) {
    if (cursorOffset >= SETTINGS_RESET_TRIGGER.length) {
      return { type: 'settings', startIndex: SETTINGS_RESET_TRIGGER.length };
    }
  } else if (value.startsWith(SETTINGS_TRIGGER)) {
    const end = Math.min(cursorOffset, value.length);
    const afterPrefix = value.slice(SETTINGS_TRIGGER.length, end);
    const keyAndSpaceMatch = afterPrefix.match(/^(\S+)\s+/);
    if (keyAndSpaceMatch) {
      const key = keyAndSpaceMatch[1] ?? '';
      const startIndex = SETTINGS_TRIGGER.length + (keyAndSpaceMatch[0]?.length ?? 0);
      return { type: 'settings_value', key, startIndex };
    }
    if (cursorOffset >= SETTINGS_TRIGGER.length) {
      return { type: 'settings', startIndex: SETTINGS_TRIGGER.length };
    }
  } else if (value.startsWith(AUTO_APPROVE_TRIGGER)) {
    if (cursorOffset >= AUTO_APPROVE_TRIGGER.length) {
      return {
        type: 'settings_value',
        key: AUTO_APPROVE_SETTING_KEY,
        startIndex: AUTO_APPROVE_TRIGGER.length,
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
