import React, { FC } from 'react';
import SettingsSelectionMenu from '../menu/SettingsSelectionMenu.js';
import SettingsValueSelectionMenu from '../menu/SettingsValueSelectionMenu.js';
import ModelSelectionMenu from '../menu/ModelSelectionMenu.js';
import RewindMenu from '../menu/RewindMenu.js';
import type { SkillInfo } from '../../services/skills/skills-service.js';
import type { PathCompletionItem } from '../../hooks/use-path-completion.js';
import type { SettingCompletionItem, SettingsCategory } from '../../hooks/use-settings-completion.js';
import type { SettingValueSuggestion } from '../../utils/value-suggestions.js';
import type { ModelInfo } from '../../services/model-service.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { RewindItem } from '../../utils/conversation/rewind-items.js';

interface PopupManagerProps {
  path: {
    isOpen: boolean;
    items: PathCompletionItem[];
    selectedIndex: number;
    scrollOffset?: number;
    query: string;
    loading: boolean;
    error: string | null;
    warning: string | null;
  };
  models: {
    isOpen: boolean;
    items: ModelInfo[];
    selectedIndex: number;
    query: string;
    loading: boolean;
    error: string | null;
    provider?: string | null;
    scrollOffset?: number;
    providerScrollOffset?: number;
    canSwitchProvider?: boolean;
  };
  settings: {
    isOpen: boolean;
    items: SettingCompletionItem[];
    selectedIndex: number;
    scrollOffset?: number;
    query: string;
    isSearchingAll: boolean;
    activeCategoryId: string;
    categories: SettingsCategory[];
  };
  settingsValue: {
    isOpen: boolean;
    settingKey: string | null;
    items: SettingValueSuggestion[];
    selectedIndex: number;
    query: string;
    isNumericSettings?: boolean;
    isFreeFormString?: boolean;
  };
  rewind: {
    isOpen: boolean;
    items: RewindItem[];
    disposition: import('../../commands/rewind-command.js').RewindDisposition;
    selectedIndex: number;
    scrollOffset?: number;
  };
  skills: {
    isOpen: boolean;
    items: SkillInfo[];
    selectedIndex: number;
    scrollOffset?: number;
    query: string;
  };
  settingsService: SettingsService;
}

export const PopupManager: FC<PopupManagerProps> = ({ models, settings, settingsValue, rewind, settingsService }) => {
  return (
    <>
      {models.isOpen && (
        <ModelSelectionMenu
          items={models.items}
          selectedIndex={models.selectedIndex}
          query={models.query}
          loading={models.loading}
          error={models.error}
          provider={models.provider}
          scrollOffset={models.scrollOffset}
          canSwitchProvider={models.canSwitchProvider}
          settingsService={settingsService}
        />
      )}
      {settings.isOpen && (
        <SettingsSelectionMenu
          items={settings.items}
          selectedIndex={settings.selectedIndex}
          scrollOffset={settings.scrollOffset}
          query={settings.query}
          isSearchingAll={settings.isSearchingAll}
          activeCategoryId={settings.activeCategoryId}
          categories={settings.categories}
        />
      )}
      {settingsValue.isOpen && settingsValue.settingKey && (
        <SettingsValueSelectionMenu
          settingKey={settingsValue.settingKey}
          items={settingsValue.items}
          selectedIndex={settingsValue.selectedIndex}
          query={settingsValue.query}
          isNumericSettings={settingsValue.isNumericSettings}
          isFreeFormString={settingsValue.isFreeFormString}
        />
      )}
      {rewind.isOpen && (
        <RewindMenu
          items={rewind.items}
          selectedIndex={rewind.selectedIndex}
          scrollOffset={rewind.scrollOffset}
          disposition={rewind.disposition}
        />
      )}
    </>
  );
};
