import React, { FC } from 'react';
import SlashCommandMenu from '../SlashCommandMenu.js';
import type { SlashCommand } from '../../slash-commands.js';
import PathSelectionMenu from '../PathSelectionMenu.js';
import SettingsSelectionMenu from '../SettingsSelectionMenu.js';
import SettingsValueSelectionMenu from '../SettingsValueSelectionMenu.js';
import ModelSelectionMenu from '../ModelSelectionMenu.js';
import UndoSelectionMenu from '../UndoSelectionMenu.js';
import ProviderSelectionMenu from '../ProviderSelectionMenu.js';
import type { PathCompletionItem } from '../../hooks/use-path-completion.js';
import type { SettingCompletionItem, SettingsCategory } from '../../hooks/use-settings-completion.js';
import type { SettingValueSuggestion } from '../../hooks/use-settings-value-completion.js';
import type { ModelInfo } from '../../services/model-service.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { UndoItem } from '../../hooks/use-undo-selection.js';
import type { ProviderSelectionMenuItem } from '../../hooks/use-provider-selection.js';

interface PopupManagerProps {
  slash: {
    isOpen: boolean;
    commands: SlashCommand[];
    selectedIndex: number;
    scrollOffset?: number;
    filter: string;
  };
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
  undo: {
    isOpen: boolean;
    items: UndoItem[];
    selectedIndex: number;
    scrollOffset?: number;
  };
  providers: {
    isOpen: boolean;
    phase: import('../../hooks/use-provider-selection.js').ProviderSelectionPhase;
    selectedIndex: number;
    scrollOffset?: number;
    activeItems: ProviderSelectionMenuItem[];
    errorMessage: string | null;
    selectedProviderName?: string;
    draft: import('../../hooks/use-provider-selection.js').CustomProviderDraft | null;
  };
  settingsService: SettingsService;
}

export const PopupManager: FC<PopupManagerProps> = ({
  slash,
  path,
  models,
  settings,
  settingsValue,
  undo,
  providers,
  settingsService,
}) => {
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
      {path.isOpen && (
        <PathSelectionMenu
          items={path.items}
          selectedIndex={path.selectedIndex}
          scrollOffset={path.scrollOffset}
          query={path.query}
          loading={path.loading}
          error={path.error}
          warning={path.warning}
        />
      )}
      {slash.isOpen && (
        <SlashCommandMenu
          commands={slash.commands}
          selectedIndex={slash.selectedIndex}
          filter={slash.filter}
          scrollOffset={slash.scrollOffset}
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
      {undo.isOpen && (
        <UndoSelectionMenu items={undo.items} selectedIndex={undo.selectedIndex} scrollOffset={undo.scrollOffset} />
      )}
      {providers.isOpen && (
        <ProviderSelectionMenu
          phase={providers.phase}
          selectedIndex={providers.selectedIndex}
          scrollOffset={providers.scrollOffset}
          activeItems={providers.activeItems}
          errorMessage={providers.errorMessage}
          selectedProviderName={providers.selectedProviderName}
          draft={providers.draft}
        />
      )}
    </>
  );
};
