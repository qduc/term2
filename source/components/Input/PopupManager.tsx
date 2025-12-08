import React, {FC} from 'react';
import SlashCommandMenu, {SlashCommand} from '../SlashCommandMenu.js';
import PathSelectionMenu from '../PathSelectionMenu.js';
import SettingsSelectionMenu from '../SettingsSelectionMenu.js';
import type {PathCompletionItem} from '../../hooks/use-path-completion.js';
import type {SettingCompletionItem} from '../../hooks/use-settings-completion.js';

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
    settings: {
        isOpen: boolean;
        items: SettingCompletionItem[];
        selectedIndex: number;
    };
}

export const PopupManager: FC<PopupManagerProps> = ({
    slash,
    path,
    settings,
}) => {
    return (
        <>
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
