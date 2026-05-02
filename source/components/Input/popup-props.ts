import type { ComponentProps } from 'react';
import type { PopupManager } from './PopupManager.js';
import type { useSlashCommands } from '../../hooks/use-slash-commands.js';
import type { usePathCompletion } from '../../hooks/use-path-completion.js';
import type { useSettingsCompletion } from '../../hooks/use-settings-completion.js';
import type { useSettingsValueCompletion } from '../../hooks/use-settings-value-completion.js';
import type { useModelSelection } from '../../hooks/use-model-selection.js';

type PopupProps = ComponentProps<typeof PopupManager>;

type Sources = {
  slash: ReturnType<typeof useSlashCommands>;
  path: ReturnType<typeof usePathCompletion>;
  settings: ReturnType<typeof useSettingsCompletion>;
  settingsValue: ReturnType<typeof useSettingsValueCompletion>;
  models: ReturnType<typeof useModelSelection>;
};

export const toPopupProps = ({
  slash,
  path,
  settings,
  settingsValue,
  models,
}: Sources): Omit<PopupProps, 'settingsService'> => ({
  slash: {
    isOpen: slash.isOpen,
    commands: slash.filteredCommands,
    selectedIndex: slash.selectedIndex,
    filter: slash.filter,
  },
  path: {
    isOpen: path.isOpen,
    items: path.filteredEntries,
    selectedIndex: path.selectedIndex,
    query: path.query,
    loading: path.loading,
    error: path.error,
  },
  models: {
    isOpen: models.isOpen,
    items: models.filteredModels,
    selectedIndex: models.selectedIndex,
    query: models.query,
    loading: models.loading,
    error: models.error,
    provider: models.provider,
    scrollOffset: models.scrollOffset,
    canSwitchProvider: models.canSwitchProvider,
  },
  settings: {
    isOpen: settings.isOpen,
    items: settings.filteredEntries,
    selectedIndex: settings.selectedIndex,
    query: settings.query,
  },
  settingsValue: {
    isOpen: settingsValue.isOpen,
    settingKey: settingsValue.settingKey,
    items: settingsValue.filteredEntries,
    selectedIndex: settingsValue.selectedIndex,
    query: settingsValue.query,
    isNumericSettings: settingsValue.isNumericSettings,
  },
});
