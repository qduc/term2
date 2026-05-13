import { MutableRefObject, useEffect } from 'react';
import type { InputMode } from '../context/InputContext.js';
import { determineActiveMenu } from '../components/Input/determine-active-menu.js';
import type { SlashCommand } from '../slash-commands.js';

type MenuHandle = {
  open: (...args: never[]) => void;
  close: () => void;
};

type SlashHandle = { open: () => void; close: () => void };
type PathHandle = { open: (start: number) => void; close: () => void };
type SettingsHandle = { open: (start: number, initialKey?: string) => void; close: () => void };
type SettingsValueHandle = { open: (key: string, start: number) => void; close: () => void };
type ModelsHandle = { open: (start: number) => void; close: () => void };

type Options = {
  value: string;
  cursorOffset: number;
  mode: InputMode;
  escPressedRef: MutableRefObject<boolean>;
  slash: SlashHandle;
  path: PathHandle;
  settings: SettingsHandle;
  settingsValue: SettingsValueHandle;
  models: ModelsHandle;
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
  escPressedRef,
  slash,
  path,
  settings,
  settingsValue,
  models,
  slashCommands,
}: Options): void => {
  useEffect(() => {
    if (escPressedRef.current) {
      escPressedRef.current = false;
      return;
    }

    const active = determineActiveMenu(value, cursorOffset, slashCommands);

    switch (active.type) {
      case 'model':
        closeAll([slash, path, settings, settingsValue]);
        models.open(active.startIndex);
        return;

      case 'settings':
        closeAll([slash, path, settingsValue, models]);
        settings.open(active.startIndex);
        return;

      case 'settings_value':
        closeAll([slash, path, settings, models]);
        settingsValue.open(active.key, active.startIndex);
        return;

      case 'slash':
        closeAll([path, settings, settingsValue, models]);
        slash.open();
        return;

      case 'path':
        closeAll([slash, settings, settingsValue, models]);
        path.open(active.trigger.start);
        return;

      case 'none':
        if (mode === 'model_selection') {
          const activeAtEnd = determineActiveMenu(value, value.length, slashCommands);
          if (activeAtEnd.type === 'model') {
            closeAll([slash, path, settings, settingsValue]);
            return;
          }
        }
        closeAll([slash, path, settings, settingsValue, models]);
        return;
    }
  }, [value, cursorOffset, mode, slash, path, settings, settingsValue, models, slashCommands, escPressedRef]);
};

// Re-export for callers that want to inspect the dispatch shape directly.
export { MenuHandle };
