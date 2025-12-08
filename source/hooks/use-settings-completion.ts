import {useCallback, useEffect, useMemo, useState} from 'react';
import Fuse from 'fuse.js';
import {SETTING_KEYS} from '../services/settings-service.js';
import { useInputContext } from '../context/InputContext.js';

export type SettingCompletionItem = {
    key: string;
    description?: string;
};

const SETTING_DESCRIPTIONS: Record<string, string> = {
    [SETTING_KEYS.AGENT_MODEL]: 'The AI model to use (e.g. gpt-4, claude-3-opus)',
    [SETTING_KEYS.AGENT_REASONING_EFFORT]: 'Reasoning effort level (default, low, medium, high)',
    [SETTING_KEYS.AGENT_PROVIDER]: 'AI provider (openai, openrouter)',
    [SETTING_KEYS.AGENT_MAX_TURNS]: 'Maximum conversation turns',
    [SETTING_KEYS.AGENT_RETRY_ATTEMPTS]: 'Number of retry attempts for failed requests',
    [SETTING_KEYS.SHELL_TIMEOUT]: 'Shell command timeout in milliseconds',
    [SETTING_KEYS.SHELL_MAX_OUTPUT_LINES]: 'Maximum lines of shell output to capture',
    [SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS]: 'Maximum characters of shell output to capture',
    [SETTING_KEYS.UI_HISTORY_SIZE]: 'Number of history items to keep',
    [SETTING_KEYS.LOGGING_LOG_LEVEL]: 'Logging level (debug, info, warn, error)',
};

const ALL_SETTINGS: SettingCompletionItem[] = Object.values(SETTING_KEYS).map(key => ({
    key,
    description: SETTING_DESCRIPTIONS[key] || '',
}));

const MAX_RESULTS = 10;

export const useSettingsCompletion = () => {
    const { mode, setMode, input, triggerIndex, setTriggerIndex } = useInputContext();

    const isOpen = mode === 'settings_completion';

    // Derive query from input + triggerIndex
    const query = useMemo(() => {
        if (!isOpen || triggerIndex === null) return '';
        // triggerIndex is the end of "/settings " prefix
        if (triggerIndex > input.length) return '';
        return input.slice(triggerIndex);
    }, [isOpen, triggerIndex, input]);

    const [selectedIndex, setSelectedIndex] = useState(0);

    const fuse = useMemo(() => {
        return new Fuse(ALL_SETTINGS, {
            keys: ['key', 'description'],
            threshold: 0.4,
        });
    }, []);

    const filteredEntries = useMemo(() => {
        if (!query.trim()) {
            return ALL_SETTINGS.slice(0, MAX_RESULTS);
        }

        return fuse
            .search(query.trim())
            .map(result => result.item)
            .slice(0, MAX_RESULTS);
    }, [fuse, query]);

    useEffect(() => {
        setSelectedIndex(prev => {
            if (filteredEntries.length === 0) {
                return 0;
            }
            return Math.min(prev, filteredEntries.length - 1);
        });
    }, [filteredEntries.length]);

    const open = useCallback((startIndex: number, _initialQuery = '') => {
        setMode('settings_completion');
        setTriggerIndex(startIndex);
        setSelectedIndex(0);
    }, [setMode, setTriggerIndex]);

    const close = useCallback(() => {
        if (mode === 'settings_completion') {
            setMode('text');
            setTriggerIndex(null);
            setSelectedIndex(0);
        }
    }, [mode, setMode, setTriggerIndex]);

    // updateQuery removed as it is derived

    const moveUp = useCallback(() => {
        setSelectedIndex(prev => {
            if (filteredEntries.length === 0) {
                return 0;
            }
            return prev > 0 ? prev - 1 : filteredEntries.length - 1;
        });
    }, [filteredEntries.length]);

    const moveDown = useCallback(() => {
        setSelectedIndex(prev => {
            if (filteredEntries.length === 0) {
                return 0;
            }
            return prev < filteredEntries.length - 1 ? prev + 1 : 0;
        });
    }, [filteredEntries.length]);

    const getSelectedItem = useCallback(() => {
        if (filteredEntries.length === 0) {
            return undefined;
        }
        const safeIndex = Math.min(selectedIndex, filteredEntries.length - 1);
        return filteredEntries[safeIndex];
    }, [filteredEntries, selectedIndex]);

    return {
        isOpen,
        triggerIndex,
        query,
        filteredEntries,
        selectedIndex,
        open,
        close,
        // updateQuery,
        moveUp,
        moveDown,
        getSelectedItem,
    };
};
