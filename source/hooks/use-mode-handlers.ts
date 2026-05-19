import { useMemo } from 'react';
import type { InputMode } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/Input/triggers.js';

export type SubmitResult = 'handled' | 'fallthrough';

export type ModeHandler = {
  moveUp: () => void;
  moveDown: () => void;
  moveLeft?: () => void;
  moveRight?: () => void;
  onTab?: () => void;
  onSubmit?: (submittedValue: string) => SubmitResult;
  onReset?: () => void;
};

type Movable = { moveUp: () => void; moveDown: () => void };
type Slash = Movable & { executeSelected: () => void; completeSelected: () => void };
type Models = Movable & { canSwitchProvider: boolean; toggleProvider: (direction?: 'next' | 'prev') => void };
type Undo = Movable & {
  confirmSelection: (onSelect: (item: import('../hooks/use-undo-selection.js').UndoItem) => void) => void;
};

type Options = {
  slash: Slash;
  path: Movable;
  settings: Movable;
  settingsValue: Movable;
  models: Models;
  undo: Undo;
  insertSelectedPath: (appendTrailingSpace: boolean) => boolean;
  insertSelectedSetting: () => boolean;
  insertSelectedSettingValue: (submitAfterInsert: boolean) => boolean;
  resetSettingValue: () => void;
  insertSelectedModel: (submitAfterInsert: boolean) => boolean;
  onSubmit: (value: string) => void;
  onSlashCommandRemount: () => void;
  onUndoSelect?: (item: import('../hooks/use-undo-selection.js').UndoItem) => void;
};

export const useModeHandlers = ({
  slash,
  path,
  settings,
  settingsValue,
  models,
  undo,
  insertSelectedPath,
  insertSelectedSetting,
  insertSelectedSettingValue,
  resetSettingValue,
  insertSelectedModel,
  onSubmit,
  onSlashCommandRemount,
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
        onTab: () => {
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
        onTab: () => {
          insertSelectedPath(false);
        },
        onSubmit: () => (insertSelectedPath(true) ? 'handled' : 'fallthrough'),
      },
      settings_completion: {
        moveUp: settings.moveUp,
        moveDown: settings.moveDown,
        onTab: () => {
          insertSelectedSetting();
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
        onTab: () => {
          insertSelectedSettingValue(false);
        },
        onSubmit: (submittedValue) => {
          if (insertSelectedSettingValue(true)) return 'handled';
          // Fall back to submitting the literal value the user typed.
          onSubmit(submittedValue);
          return 'handled';
        },
        onReset: resetSettingValue,
      },
      model_selection: {
        moveUp: models.moveUp,
        moveDown: models.moveDown,
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
        onSubmit: () => {
          if (onUndoSelect) {
            undo.confirmSelection(onUndoSelect);
          }
          return 'handled';
        },
      },
    }),
    [
      slash,
      path,
      settings,
      settingsValue,
      models,
      undo,
      insertSelectedPath,
      insertSelectedSetting,
      insertSelectedSettingValue,
      resetSettingValue,
      insertSelectedModel,
      onSubmit,
      onSlashCommandRemount,
      onUndoSelect,
    ],
  );
};
