import type { ComponentProps } from 'react';
import type { PopupManager } from './PopupManager.js';
import type { usePathCompletion } from '../../hooks/use-path-completion.js';
import type { useSettingsCompletion } from '../../hooks/use-settings-completion.js';
import type { useSettingsValueCompletion } from '../../hooks/use-settings-value-completion.js';
import type { useModelSelection } from '../../hooks/use-model-selection.js';
import type { useRewindSelection } from '../../hooks/use-rewind-selection.js';
import type { useSkillSelection } from '../../hooks/use-skill-selection.js';

type PopupProps = ComponentProps<typeof PopupManager>;

type Sources = {
  path: ReturnType<typeof usePathCompletion>;
  settings: ReturnType<typeof useSettingsCompletion>;
  settingsValue: ReturnType<typeof useSettingsValueCompletion>;
  models: ReturnType<typeof useModelSelection>;
  skills: ReturnType<typeof useSkillSelection>;
  rewind: ReturnType<typeof useRewindSelection>;
};

export const toPopupProps = ({
  path,
  settings,
  settingsValue,
  models,
  skills,
  rewind,
}: Sources): Omit<PopupProps, 'settingsService'> => ({
  path: {
    isOpen: path.isOpen,
    items: path.filteredEntries,
    selectedIndex: path.selectedIndex,
    scrollOffset: path.scrollOffset,
    query: path.query,
    loading: path.loading,
    error: path.error,
    warning: path.warning,
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
    scrollOffset: settings.scrollOffset,
    query: settings.query,
    isSearchingAll: settings.isSearchingAll,
    activeCategoryId: settings.activeCategoryId,
    categories: settings.categories,
  },
  settingsValue: {
    isOpen: settingsValue.isOpen,
    settingKey: settingsValue.settingKey,
    items: settingsValue.filteredEntries,
    selectedIndex: settingsValue.selectedIndex,
    query: settingsValue.query,
    isNumericSettings: settingsValue.isNumericSettings,
  },
  rewind: {
    isOpen: rewind.isOpen,
    items: rewind.items,
    selectedIndex: rewind.selectedIndex,
    scrollOffset: rewind.scrollOffset,
    disposition: rewind.disposition,
  },
  skills: {
    isOpen: skills.isOpen,
    items: skills.skills,
    selectedIndex: skills.selectedIndex,
    scrollOffset: skills.scrollOffset,
    query: skills.query,
  },
});
