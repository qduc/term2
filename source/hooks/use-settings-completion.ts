import {useCallback, useEffect, useMemo, useState} from 'react';
import Fuse from 'fuse.js';
import {
    SETTING_KEYS,
    SENSITIVE_SETTINGS,
    type SettingsService,
} from '../services/settings-service.js';
import {useInputContext} from '../context/InputContext.js';

export type SettingCompletionItem = {
    key: string;
    description?: string;
    currentValue?: string | number | boolean;
};

const SETTING_DESCRIPTIONS: Record<string, string> = {
    [SETTING_KEYS.AGENT_MODEL]:
        'The AI model to use (e.g. gpt-4, claude-3-opus)',
    [SETTING_KEYS.AGENT_REASONING_EFFORT]:
        'Reasoning effort (none|minimal|low|medium|high|default)',
    [SETTING_KEYS.AGENT_TEMPERATURE]:
        'Model temperature (0–2, controls randomness)',
    [SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER]:
        'Use OpenAI Flex Service Tier to reduce costs (true|false, OpenAI only)',
    // agent.provider is hidden from UI - it can only be changed via model menu
    [SETTING_KEYS.AGENT_MAX_TURNS]: 'Maximum conversation turns',
    [SETTING_KEYS.AGENT_RETRY_ATTEMPTS]:
        'Number of retry attempts for failed requests',
    [SETTING_KEYS.SHELL_TIMEOUT]: 'Shell command timeout in milliseconds',
    [SETTING_KEYS.SHELL_MAX_OUTPUT_LINES]:
        'Maximum lines of shell output to capture',
    [SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS]:
        'Maximum characters of shell output to capture',
    [SETTING_KEYS.UI_HISTORY_SIZE]: 'Number of history items to keep',
    [SETTING_KEYS.LOGGING_LOG_LEVEL]:
        'Logging level (debug, info, warn, error)',
    [SETTING_KEYS.LOGGING_SUPPRESS_CONSOLE]:
        'Suppress console output (true|false) to avoid interfering with Ink UI',
};

/**
 * Settings that should be hidden from the UI (not for security, but for UX/workflow)
 * - agent.provider: Can only be changed at the start of a new conversation via model menu
 */
const HIDDEN_SETTINGS = new Set<string>([SETTING_KEYS.AGENT_PROVIDER]);

const MAX_RESULTS = 10;

const COMMON_SETTINGS: string[] = [
    SETTING_KEYS.AGENT_MODEL,
    SETTING_KEYS.AGENT_REASONING_EFFORT,
    SETTING_KEYS.AGENT_TEMPERATURE,
    SETTING_KEYS.AGENT_MAX_TURNS,
    SETTING_KEYS.LOGGING_LOG_LEVEL,
    SETTING_KEYS.SHELL_TIMEOUT,
];

function categoryRank(key: string): number {
    const prefix = key.split('.')[0] || '';
    const ranks: Record<string, number> = {
        common: 0,
        agent: 1,
        shell: 2,
        ui: 3,
        logging: 4,
        providers: 5,
        webSearch: 6,
    };
    return ranks[prefix] ?? 50;
}

function sortSettings(a: SettingCompletionItem, b: SettingCompletionItem): number {
    const aCommonIndex = COMMON_SETTINGS.indexOf(a.key);
    const bCommonIndex = COMMON_SETTINGS.indexOf(b.key);
    const aIsCommon = aCommonIndex !== -1;
    const bIsCommon = bCommonIndex !== -1;

    if (aIsCommon && bIsCommon) return aCommonIndex - bCommonIndex;
    if (aIsCommon) return -1;
    if (bIsCommon) return 1;

    const aRank = categoryRank(a.key);
    const bRank = categoryRank(b.key);
    if (aRank !== bRank) return aRank - bRank;
    return a.key.localeCompare(b.key);
}

/**
 * Get the set of sensitive setting keys that should not appear in the UI
 */
function getSensitiveSettingKeysSet(): Set<string> {
    return new Set(Object.values(SENSITIVE_SETTINGS));
}

/**
 * Get the current value of a setting for display in the menu
 */
function getCurrentSettingValue(
    settingsService: SettingsService,
    key: string,
): string | number | boolean | undefined {
    try {
        const value = settingsService.get(key);
        // Format the value for display
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }
        return value;
    } catch {
        return undefined;
    }
}

// Pure functions exported for testing
export function buildSettingsList(
    settingKeys: Record<string, string>,
    descriptions: Record<string, string>,
    excludeSensitive: boolean = true,
    getCurrentValue?: (key: string) => string | number | boolean | undefined,
): SettingCompletionItem[] {
    const sensitiveKeys = excludeSensitive
        ? getSensitiveSettingKeysSet()
        : new Set<string>();

    return Object.values(settingKeys)
        .filter(key => !sensitiveKeys.has(key) && !HIDDEN_SETTINGS.has(key))
        .map(key => ({
            key,
            description: descriptions[key] || '',
            currentValue: getCurrentValue?.(key),
        }))
        .sort(sortSettings);
}

export function filterSettingsByQuery(
    settings: SettingCompletionItem[],
    query: string,
    fuseInstance: Fuse<SettingCompletionItem>,
    maxResults: number = 10,
): SettingCompletionItem[] {
    if (!query.trim()) {
        return settings;
    }

    return fuseInstance
        .search(query.trim())
        .map(result => result.item)
        .slice(0, maxResults);
}

export function clampIndex(currentIndex: number, arrayLength: number): number {
    if (arrayLength === 0) {
        return 0;
    }
    return Math.min(currentIndex, arrayLength - 1);
}

export const useSettingsCompletion = (settingsService: SettingsService) => {
    const {mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex} =
        useInputContext();

    const isOpen = mode === 'settings_completion';

    // Derive query from input + triggerIndex
    const query = useMemo(() => {
        if (!isOpen || triggerIndex === null) return '';
        // triggerIndex is the end of "/settings " prefix
        if (triggerIndex > input.length) return '';
        const end = Math.min(cursorOffset, input.length);
        return input.slice(triggerIndex, end);
    }, [isOpen, triggerIndex, input, cursorOffset]);

    const [selectedIndex, setSelectedIndex] = useState(0);
    const [settingsVersion, setSettingsVersion] = useState(0);

    // Refresh the list whenever a setting changes so currentValue stays accurate
    useEffect(() => {
        const unsubscribe = settingsService.onChange(() => {
            setSettingsVersion(prev => prev + 1);
        });
        return unsubscribe;
    }, [settingsService]);

    const allSettings = useMemo(() => {
        return buildSettingsList(
            SETTING_KEYS,
            SETTING_DESCRIPTIONS,
            true,
            (key: string) => getCurrentSettingValue(settingsService, key),
        );
    }, [settingsVersion, settingsService]);

    const fuse = useMemo(() => {
        return new Fuse(allSettings, {
            keys: ['key', 'description'],
            threshold: 0.4,
        });
    }, [allSettings]);

    const filteredEntries = useMemo(() => {
        return filterSettingsByQuery(allSettings, query, fuse, MAX_RESULTS);
    }, [allSettings, fuse, query]);

    useEffect(() => {
        setSelectedIndex(prev => clampIndex(prev, filteredEntries.length));
    }, [filteredEntries.length]);

    const [targetKey, setTargetKey] = useState<string | null>(null);

    // Effect to select a target key once it appears in filteredEntries
    useEffect(() => {
        if (targetKey && filteredEntries.length > 0) {
            const index = filteredEntries.findIndex(
                item => item.key === targetKey,
            );
            if (index !== -1) {
                setSelectedIndex(index);
                setTargetKey(null);
            }
        }
    }, [filteredEntries, targetKey]);

    const open = useCallback(
        (startIndex: number, initialSelectionKey?: string) => {
            // If already in settings mode, do not reset selection.
            if (mode === 'settings_completion') return;
            setMode('settings_completion');
            setTriggerIndex(startIndex);
            if (initialSelectionKey) {
                setTargetKey(initialSelectionKey);
            } else {
                setSelectedIndex(0);
            }
        },
        [mode, setMode, setTriggerIndex],
    );

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
        const safeIndex = clampIndex(selectedIndex, filteredEntries.length);
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
