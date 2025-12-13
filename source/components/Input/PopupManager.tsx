import React, {FC} from 'react';
import SlashCommandMenu, {SlashCommand} from '../SlashCommandMenu.js';
import PathSelectionMenu from '../PathSelectionMenu.js';
import SettingsSelectionMenu from '../SettingsSelectionMenu.js';
import ModelSelectionMenu from '../ModelSelectionMenu.js';
import type {PathCompletionItem} from '../../hooks/use-path-completion.js';
import type {SettingCompletionItem} from '../../hooks/use-settings-completion.js';
import type {ModelInfo} from '../../services/model-service.js';
import type {SettingsService} from '../../services/settings-service.js';

interface PopupManagerProps {
    slash: {
        isOpen: boolean;
        commands: SlashCommand[];
        selectedIndex: number;
        filter: string;
    };
    path: {
        isOpen: boolean;
        items: PathCompletionItem[];
        selectedIndex: number;
        query: string;
        loading: boolean;
        error: string | null;
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
        canSwitchProvider?: boolean;
    };
    settings: {
        isOpen: boolean;
        items: SettingCompletionItem[];
        selectedIndex: number;
    };
    settingsService: SettingsService;
}

export const PopupManager: FC<PopupManagerProps> = ({
    slash,
    path,
    models,
    settings,
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
                    query={path.query}
                    loading={path.loading}
                    error={path.error}
                />
            )}
            {slash.isOpen && (
                <SlashCommandMenu
                    commands={slash.commands}
                    selectedIndex={slash.selectedIndex}
                    filter={slash.filter}
                />
            )}
            {settings.isOpen && (
                <SettingsSelectionMenu
                    items={settings.items}
                    selectedIndex={settings.selectedIndex}
                />
            )}
        </>
    );
};
