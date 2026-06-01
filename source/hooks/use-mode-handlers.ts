import { useMemo } from 'react';
import type { InputMode } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/Input/triggers.js';
import type { ProviderSelectionPhase } from './use-provider-selection.js';

export type SubmitResult = 'handled' | 'fallthrough';

export type ModeHandler = {
  moveUp: () => void;
  moveDown: () => void;
  pageUp?: () => void;
  pageDown?: () => void;
  moveHome?: () => void;
  moveEnd?: () => void;
  moveLeft?: () => void;
  moveRight?: () => void;
  onTab?: () => void;
  onSubmit?: (submittedValue: string) => SubmitResult;
  onReset?: () => void;
};

type Movable = {
  moveUp: () => void;
  moveDown: () => void;
  moveHome: () => void;
  moveEnd: () => void;
  pageUp: () => void;
  pageDown: () => void;
};
type Settings = Movable & {
  switchCategory: (direction?: 'next' | 'prev') => void;
};
import type { SlashCommand } from '../slash-commands.js';

type Slash = Movable & {
  executeSelected: () => void;
  completeSelected: () => void;
  getSelectedItem: () => SlashCommand | undefined;
};
type Models = Movable & { canSwitchProvider: boolean; toggleProvider: (direction?: 'next' | 'prev') => void };
type Undo = Movable & {
  confirmSelection: (onSelect: (item: import('../hooks/use-undo-selection.js').UndoItem) => void) => void;
};
type Providers = {
  phase: ProviderSelectionPhase;
  moveUp: () => void;
  moveDown: () => void;
  selectItem: () => void;
  goBack: () => void;
  handleTextInputSubmit: (value: string) => boolean;
};

type Options = {
  slash: Slash;
  path: Movable;
  settings: Settings;
  settingsValue: Movable;
  models: Models;
  undo: Undo;
  providers: Providers;
  insertSelectedPath: (appendTrailingSpace: boolean) => boolean;
  insertSelectedSetting: () => boolean;
  insertSelectedSettingValue: (submitAfterInsert: boolean, typedValue?: string) => boolean;
  resetSettingValue: () => void;
  insertSelectedModel: (submitAfterInsert: boolean) => boolean;
  onSubmit: (value: string) => void;
  onSlashCommandRemount: () => void;
  onSlashTabComplete?: (command: SlashCommand) => boolean;
  onUndoSelect?: (item: import('../hooks/use-undo-selection.js').UndoItem) => void;
};

export const useModeHandlers = ({
  slash,
  path,
  settings,
  settingsValue,
  models,
  undo,
  providers,
  insertSelectedPath,
  insertSelectedSetting,
  insertSelectedSettingValue,
  resetSettingValue,
  insertSelectedModel,
  onSubmit,
  onSlashCommandRemount,
  onSlashTabComplete,
  onUndoSelect,
}: Options): Record<InputMode, ModeHandler> => {
  return useMemo(
    () => ({
      text: {
        moveUp: () => {},
        moveDown: () => {},
      },
      slash_commands: {
        moveUp: slash.moveUp,
        moveDown: slash.moveDown,
        pageUp: slash.pageUp,
        pageDown: slash.pageDown,
        moveHome: slash.moveHome,
        moveEnd: slash.moveEnd,
        onTab: () => {
          const selected = slash.getSelectedItem();
          if (selected && onSlashTabComplete && onSlashTabComplete(selected)) {
            return 'handled';
          }
          slash.completeSelected();
          onSlashCommandRemount();
          return 'handled';
        },
        onSubmit: () => {
          slash.executeSelected();
          onSlashCommandRemount();
          return 'handled';
        },
      },
      path_completion: {
        moveUp: path.moveUp,
        moveDown: path.moveDown,
        pageUp: path.pageUp,
        pageDown: path.pageDown,
        moveHome: path.moveHome,
        moveEnd: path.moveEnd,
        onTab: () => {
          insertSelectedPath(false);
        },
        onSubmit: () => (insertSelectedPath(true) ? 'handled' : 'fallthrough'),
      },
      settings_completion: {
        moveUp: settings.moveUp,
        moveDown: settings.moveDown,
        pageUp: settings.pageUp,
        pageDown: settings.pageDown,
        moveHome: settings.moveHome,
        moveEnd: settings.moveEnd,
        moveLeft: () => {
          settings.switchCategory('prev');
        },
        moveRight: () => {
          settings.switchCategory('next');
        },
        onTab: () => {
          settings.switchCategory();
        },
        onSubmit: (submittedValue) => {
          // If the user has typed key + value already, submit through.
          const parts = submittedValue.slice(SETTINGS_TRIGGER.length).trim().split(/\s+/);
          if (parts.length >= 2) {
            onSubmit(submittedValue);
            return 'handled';
          }
          return insertSelectedSetting() ? 'handled' : 'fallthrough';
        },
      },
      settings_value_completion: {
        moveUp: settingsValue.moveUp,
        moveDown: settingsValue.moveDown,
        pageUp: settingsValue.pageUp,
        pageDown: settingsValue.pageDown,
        moveHome: settingsValue.moveHome,
        moveEnd: settingsValue.moveEnd,
        onTab: () => {
          insertSelectedSettingValue(false);
        },
        onSubmit: (submittedValue) => {
          if (insertSelectedSettingValue(true, submittedValue)) return 'handled';
          // Fall back to submitting the literal value the user typed.
          onSubmit(submittedValue);
          return 'handled';
        },
        onReset: resetSettingValue,
      },
      model_selection: {
        moveUp: models.moveUp,
        moveDown: models.moveDown,
        pageUp: models.pageUp,
        pageDown: models.pageDown,
        moveHome: models.moveHome,
        moveEnd: models.moveEnd,
        moveLeft: () => {
          if (models.canSwitchProvider) models.toggleProvider('prev');
        },
        moveRight: () => {
          if (models.canSwitchProvider) models.toggleProvider('next');
        },
        onTab: () => {
          if (models.canSwitchProvider) models.toggleProvider();
        },
        onSubmit: () => (insertSelectedModel(true) ? 'handled' : 'fallthrough'),
      },
      undo_selection: {
        moveUp: undo.moveUp,
        moveDown: undo.moveDown,
        pageUp: undo.pageUp,
        pageDown: undo.pageDown,
        moveHome: undo.moveHome,
        moveEnd: undo.moveEnd,
        onSubmit: () => {
          if (onUndoSelect) {
            undo.confirmSelection(onUndoSelect);
          }
          return 'handled';
        },
      },
      provider_selection: {
        moveUp: providers.moveUp,
        moveDown: providers.moveDown,
        onSubmit: (submittedValue: string) => {
          if (
            providers.phase === 'wizard_name' ||
            providers.phase === 'wizard_url' ||
            providers.phase === 'wizard_key'
          ) {
            providers.handleTextInputSubmit(submittedValue);
            return 'handled';
          }

          providers.selectItem();
          return 'handled';
        },
        onReset: providers.goBack,
      },
    }),
    [
      slash,
      path,
      settings,
      settingsValue,
      models,
      undo,
      providers,
      insertSelectedPath,
      insertSelectedSetting,
      insertSelectedSettingValue,
      resetSettingValue,
      insertSelectedModel,
      onSubmit,
      onSlashCommandRemount,
      onSlashTabComplete,
      onUndoSelect,
    ],
  );
};
