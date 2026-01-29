import {useCallback, useEffect, useMemo, useState} from 'react';
import Fuse from 'fuse.js';
import {useInputContext} from '../context/InputContext.js';
import type {SettingsService} from '../services/settings-service.js';

export type SettingValueSuggestion = {
    value: string;
    description?: string;
};

const MAX_RESULTS = 10;

const NUMBER_SETTING_KEYS = new Set([
    'agent.temperature',
    'agent.maxTurns',
    'agent.retryAttempts',
    'shell.timeout',
    'shell.maxOutputLines',
    'shell.maxOutputChars',
    'ui.historySize',
    'ssh.port',
]);

// A small, curated set of value suggestions for common settings.
// This is intentionally conservative: it's better to suggest a few helpful values
// than to pretend we can enumerate every possible value.
const VALUE_SUGGESTIONS_BY_KEY: Record<string, SettingValueSuggestion[]> = {
    'agent.reasoningEffort': [
        {value: 'none', description: 'No reasoning (fastest)'},
        {value: 'minimal', description: 'Very low reasoning'},
        {value: 'low', description: 'Low reasoning'},
        {value: 'medium', description: 'Balanced'},
        {value: 'high', description: 'Highest reasoning'},
        {value: 'default', description: 'Model default'},
    ],
    'agent.mentorReasoningEffort': [
        {value: 'none', description: 'No reasoning (fastest)'},
        {value: 'minimal', description: 'Very low reasoning'},
        {value: 'low', description: 'Low reasoning'},
        {value: 'medium', description: 'Balanced'},
        {value: 'high', description: 'Highest reasoning'},
        {value: 'default', description: 'Model default'},
    ],
    'logging.logLevel': [
        {value: 'debug'},
        {value: 'info'},
        {value: 'warn'},
        {value: 'error'},
    ],
    'logging.suppressConsoleOutput': [{value: 'true'}, {value: 'false'}],
    'tools.enableEditHealing': [{value: 'true'}, {value: 'false'}],
    'agent.useFlexServiceTier': [
        {value: 'true', description: 'Enable Flex Service Tier (lower cost)'},
        {value: 'false', description: 'Use standard service tier'},
    ],
    'agent.temperature': [
        {value: '0', description: 'Deterministic'},
        {value: '0.2'},
        {value: '0.7'},
        {value: '1'},
        {value: '1.2'},
        {value: '2', description: 'Most random'},
    ],
    'shell.timeout': [
        {value: '60000', description: '60s'},
        {value: '120000', description: '120s'},
        {value: '300000', description: '5m'},
    ],
    'shell.maxOutputLines': [
        {value: '200'},
        {value: '500'},
        {value: '1000'},
    ],
    'shell.maxOutputChars': [
        {value: '20000'},
        {value: '50000'},
        {value: '100000'},
    ],
    'ui.historySize': [
        {value: '50'},
        {value: '100'},
        {value: '200'},
    ],
    'agent.maxTurns': [
        {value: '10'},
        {value: '20'},
        {value: '50'},
    ],
    'agent.retryAttempts': [
        {value: '1'},
        {value: '2'},
        {value: '3'},
    ],
    'ssh.port': [
        {value: '22', description: 'Default SSH port'},
    ],
};

// Pure functions exported for testing
export function buildSettingValueSuggestions(
    key: string,
): SettingValueSuggestion[] {
    // If we don't know the key, return empty and let users type freely.
    return VALUE_SUGGESTIONS_BY_KEY[key] ?? [];
}

export function filterSettingValueSuggestionsByQuery(
    suggestions: SettingValueSuggestion[],
    query: string,
    fuse: Fuse<SettingValueSuggestion>,
    maxResults: number = MAX_RESULTS,
    key?: string,
): SettingValueSuggestion[] {
    if (!query.trim()) {
        return suggestions.slice(0, maxResults);
    }

    const results = fuse.search(query.trim()).map(r => r.item);

    // For number settings, if the query itself is a valid number and not already
    // in the results as an exact match, add it as a "Custom value" option.
    if (
        key &&
        NUMBER_SETTING_KEYS.has(key) &&
        query.trim() &&
        !results.some(r => r.value === query.trim())
    ) {
        const numValue = Number(query.trim());
        if (!isNaN(numValue)) {
            // Add to the START of results so it's the default choice
            // when typing a custom value.
            results.unshift({
                value: query.trim(),
                description: 'Custom value',
            });
        }
    }

    return results.slice(0, maxResults);
}

export const useSettingsValueCompletion = (settingsService: SettingsService) => {
    const {mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex} =
        useInputContext();

    const isOpen = mode === 'settings_value_completion';

    const [settingKey, setSettingKey] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [settingsVersion, setSettingsVersion] = useState(0);

    // Recompute current setting value suggestions when settings change.
    // (Useful if we later want to add "current" or dynamic suggestions.)
    useEffect(() => {
        const unsubscribe = settingsService.onChange(() => {
            setSettingsVersion(v => v + 1);
        });
        return unsubscribe;
    }, [settingsService]);

    const query = useMemo(() => {
        if (!isOpen || triggerIndex === null) return '';
        const end = Math.min(cursorOffset, input.length);
        return input.slice(triggerIndex, end);
    }, [isOpen, triggerIndex, input, cursorOffset]);

    const allSuggestions = useMemo(() => {
        if (!settingKey) return [];
        // settingsVersion is used to allow refresh when values change.
        void settingsVersion;
        return buildSettingValueSuggestions(settingKey);
    }, [settingKey, settingsVersion]);

    const fuse = useMemo(() => {
        return new Fuse(allSuggestions, {
            keys: ['value', 'description'],
            threshold: 0.4,
        });
    }, [allSuggestions]);

    const filteredEntries = useMemo(() => {
        return filterSettingValueSuggestionsByQuery(
            allSuggestions,
            query,
            fuse,
            MAX_RESULTS,
            settingKey ?? undefined,
        );
    }, [allSuggestions, query, fuse, settingKey]);

    useEffect(() => {
        setSelectedIndex(prev => {
            if (filteredEntries.length === 0) return 0;
            return Math.min(prev, filteredEntries.length - 1);
        });
    }, [filteredEntries.length]);

    const open = useCallback(
        (key: string, valueStartIndex: number) => {
            if (mode === 'settings_value_completion' && settingKey === key) {
                return;
            }
            setSettingKey(key);
            setMode('settings_value_completion');
            setTriggerIndex(valueStartIndex);
            setSelectedIndex(0);
        },
        [mode, setMode, setTriggerIndex, settingKey],
    );

    const close = useCallback(() => {
        if (mode === 'settings_value_completion') {
            setMode('text');
            setTriggerIndex(null);
            setSelectedIndex(0);
            setSettingKey(null);
        }
    }, [mode, setMode, setTriggerIndex]);

    const moveUp = useCallback(() => {
        setSelectedIndex(prev => {
            if (filteredEntries.length === 0) return 0;
            return prev > 0 ? prev - 1 : filteredEntries.length - 1;
        });
    }, [filteredEntries.length]);

    const moveDown = useCallback(() => {
        setSelectedIndex(prev => {
            if (filteredEntries.length === 0) return 0;
            return prev < filteredEntries.length - 1 ? prev + 1 : 0;
        });
    }, [filteredEntries.length]);

    const getSelectedItem = useCallback(() => {
        if (filteredEntries.length === 0) return undefined;
        const safeIndex = Math.min(selectedIndex, filteredEntries.length - 1);
        return filteredEntries[safeIndex];
    }, [filteredEntries, selectedIndex]);

    const isNumericSettings = useMemo(() => {
        return settingKey ? NUMBER_SETTING_KEYS.has(settingKey) : false;
    }, [settingKey]);

    return {
        isOpen,
        triggerIndex,
        settingKey,
        query,
        filteredEntries,
        selectedIndex,
        open,
        close,
        moveUp,
        moveDown,
        getSelectedItem,
        isNumericSettings,
    };
};
