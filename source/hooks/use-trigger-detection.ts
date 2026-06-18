import { MutableRefObject, useEffect, useRef } from 'react';
import type { InputMode } from '../context/InputContext.js';
import { determineActiveMenu } from '../components/input/determine-active-menu.js';
import type { SlashCommand } from '../slash-commands.js';
import type { CompletionDismissal } from './use-escape-key.js';

type MenuHandle = {
  open: (...args: never[]) => void;
  close: () => void;
};

type SlashHandle = { open: () => void; close: () => void };
type PathHandle = { open: (start: number) => void; close: () => void };
type SettingsHandle = { open: (start: number, initialKey?: string) => void; close: () => void };
type SettingsValueHandle = { open: (key: string, start: number) => void; close: () => void };
type ModelsHandle = { open: (start: number) => void; close: () => void };
type SkillsHandle = { open: (start: number) => void; close: () => void };

type Options = {
  value: string;
  cursorOffset: number;
  mode: InputMode;
  dismissedCompletionRef: MutableRefObject<CompletionDismissal>;
  inputRevisionRef: MutableRefObject<number>;
  slash: SlashHandle;
  path: PathHandle;
  settings: SettingsHandle;
  settingsValue: SettingsValueHandle;
  models: ModelsHandle;
  skills: SkillsHandle;
  slashCommands: SlashCommand[];
};

// Closes are mode-guarded inside each hook, so calling them on inactive menus is a no-op.
const closeAll = (menus: { close: () => void }[]) => {
  for (const m of menus) m.close();
};

export const useTriggerDetection = ({
  value,
  cursorOffset,
  mode,
  dismissedCompletionRef,
  inputRevisionRef,
  slash,
  path,
  settings,
  settingsValue,
  models,
  skills,
  slashCommands,
}: Options): void => {
  const previousValueRef = useRef(value);
  const previousCursorRef = useRef(cursorOffset);

  useEffect(() => {
    // Detect value changes → bump revision + clear dismissal.
    if (value !== previousValueRef.current) {
      inputRevisionRef.current += 1;
      dismissedCompletionRef.current = null;
      previousValueRef.current = value;
    }

    // Detect cursor movement → clear dismissal so navigation keys (arrows,
    // home/end) allow the popup to re-trigger immediately.
    if (cursorOffset !== previousCursorRef.current) {
      dismissedCompletionRef.current = null;
      previousCursorRef.current = cursorOffset;
    }

    const active = determineActiveMenu(value, cursorOffset, slashCommands);

    switch (active.type) {
      case 'model':
        closeAll([slash, path, settings, settingsValue, skills]);
        if (mode !== 'model_selection') {
          models.open(active.startIndex);
        }
        return;

      case 'settings':
        closeAll([slash, path, settingsValue, models, skills]);
        if (mode !== 'settings_completion') {
          settings.open(active.startIndex);
        }
        return;

      case 'settings_value': {
        // Respect dismissal from ESC for settings_value popups.
        if (
          dismissedCompletionRef.current?.type === 'settings_value' &&
          dismissedCompletionRef.current.inputRevision === inputRevisionRef.current
        ) {
          return;
        }

        closeAll([slash, path, settings, models, skills]);
        if (mode !== 'settings_value_completion') {
          settingsValue.open(active.key, active.startIndex);
        }
        return;
      }

      case 'skills':
        if (
          dismissedCompletionRef.current?.type === 'skill_selection' &&
          dismissedCompletionRef.current.inputRevision === inputRevisionRef.current
        ) {
          return;
        }

        closeAll([slash, path, settings, settingsValue, models]);
        if (mode !== 'skill_selection') {
          skills.open(active.startIndex);
        }
        return;

      case 'slash':
        closeAll([path, settings, settingsValue, models, skills]);
        if (mode !== 'slash_commands') {
          slash.open();
        }
        return;

      case 'path': {
        // Respect dismissal from ESC for path_completion popups.
        if (
          dismissedCompletionRef.current?.type === 'path' &&
          dismissedCompletionRef.current.inputRevision === inputRevisionRef.current
        ) {
          return;
        }

        closeAll([slash, settings, settingsValue, models, skills]);
        if (mode !== 'path_completion') {
          path.open(active.trigger.start);
        }
        return;
      }

      case 'none':
        if (mode === 'model_selection') {
          const activeAtEnd = determineActiveMenu(value, value.length, slashCommands);
          if (activeAtEnd.type === 'model') {
            closeAll([slash, path, settings, settingsValue, skills]);
            return;
          }
        }
        closeAll([slash, path, settings, settingsValue, models, skills]);
        return;
    }
  }, [
    value,
    cursorOffset,
    mode,
    slash,
    path,
    settings,
    settingsValue,
    models,
    skills,
    slashCommands,
    dismissedCompletionRef,
    inputRevisionRef,
  ]);
};

// Re-export for callers that want to inspect the dispatch shape directly.
export { MenuHandle };
