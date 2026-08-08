import { useMemo } from 'react';
import type { InputMode } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/input/triggers.js';
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
  onRefresh?: () => void;
  onReset?: () => void;
  onDelete?: () => void;
  onMoveItemUp?: () => void;
  onMoveItemDown?: () => void;
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
type Models = Movable & {
  canSwitchProvider: boolean;
  toggleProvider: (direction?: 'next' | 'prev') => void;
  refresh: () => void;
};
type Rewind = Movable & {
  disposition: import('../commands/rewind-command.js').RewindDisposition;
  toggleDisposition: () => void;
  confirmSelection: (
    onSelect: (
      item: import('../utils/conversation/rewind-items.js').RewindItem,
      disposition: import('../commands/rewind-command.js').RewindDisposition,
    ) => void,
  ) => void;
};
type Providers = {
  phase: ProviderSelectionPhase;
  moveUp: () => void;
  moveDown: () => void;
  selectItem: () => void;
  goBack: () => void;
  requestDelete: () => void;
  handleTextInputSubmit: (value: string) => boolean;
  moveProviderUp: () => void;
  moveProviderDown: () => void;
};

type Options = {
  slash: Slash;
  path: Movable;
  settings: Settings;
  settingsValue: Movable;
  models: Models;
  skills: Movable;
  rewind: Rewind;
  providers?: Providers;
  insertSelectedPath: (appendTrailingSpace: boolean) => boolean;
  insertSelectedSetting: () => boolean;
  insertSelectedSettingValue: (submitAfterInsert: boolean, typedValue?: string) => boolean;
  resetSettingValue: () => void;
  insertSelectedModel: (submitAfterInsert: boolean) => boolean;
  insertSelectedSkill: (submitAfterInsert: boolean) => boolean;
  onSubmit: (value: string) => void;
  onSlashCommandRemount: () => void;
  onSlashTabComplete?: (command: SlashCommand) => boolean;
  onRewindSelect?: (
    item: import('../utils/conversation/rewind-items.js').RewindItem,
    disposition: import('../commands/rewind-command.js').RewindDisposition,
  ) => void;
};

export const useModeHandlers = ({
  slash,
  path,
  settings,
  settingsValue,
  models,
  skills,
  rewind,
  providers,
  insertSelectedPath,
  insertSelectedSetting,
  insertSelectedSettingValue,
  resetSettingValue,
  insertSelectedModel,
  insertSelectedSkill,
  onSubmit,
  onSlashCommandRemount,
  onSlashTabComplete,
  onRewindSelect,
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
          insertSelectedModel(false);
        },
        onSubmit: () => (insertSelectedModel(true) ? 'handled' : 'fallthrough'),
        onRefresh: models.refresh,
      },
      skill_selection: {
        moveUp: skills.moveUp,
        moveDown: skills.moveDown,
        pageUp: skills.pageUp,
        pageDown: skills.pageDown,
        moveHome: skills.moveHome,
        moveEnd: skills.moveEnd,
        onSubmit: () => (insertSelectedSkill(true) ? 'handled' : 'fallthrough'),
      },
      rewind_selection: {
        moveUp: rewind.moveUp,
        moveDown: rewind.moveDown,
        pageUp: rewind.pageUp,
        pageDown: rewind.pageDown,
        moveHome: rewind.moveHome,
        moveEnd: rewind.moveEnd,
        // Tab switches between restoring the turn for editing and resending it,
        // so the choice does not have to be made before opening the picker.
        onTab: () => {
          rewind.toggleDisposition();
        },
        onSubmit: () => {
          if (onRewindSelect) {
            rewind.confirmSelection(onRewindSelect);
          }
          return 'handled';
        },
      },
      provider_selection: {
        moveUp: providers?.moveUp ?? (() => {}),
        moveDown: providers?.moveDown ?? (() => {}),
        onSubmit: (submittedValue: string) => {
          if (!providers) return 'fallthrough';
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
        onReset: providers?.goBack,
        onDelete: () => {
          if (providers?.phase === 'list') {
            providers.requestDelete();
          }
        },
        onMoveItemUp: () => {
          if (providers?.phase === 'reorder') {
            providers.moveProviderUp();
          }
        },
        onMoveItemDown: () => {
          if (providers?.phase === 'reorder') {
            providers.moveProviderDown();
          }
        },
      },
    }),
    [
      slash,
      path,
      settings,
      settingsValue,
      models,
      skills,
      rewind,
      providers,
      insertSelectedPath,
      insertSelectedSetting,
      insertSelectedSettingValue,
      resetSettingValue,
      insertSelectedModel,
      insertSelectedSkill,
      onSubmit,
      onSlashCommandRemount,
      onSlashTabComplete,
      onRewindSelect,
    ],
  );
};
