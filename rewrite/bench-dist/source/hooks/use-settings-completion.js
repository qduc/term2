import { useCallback, useEffect, useMemo, useState } from 'react';
import { SETTING_KEYS } from '../services/settings/settings-service.js';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import { SETTING_ENV_VARIABLES } from '../services/settings/settings-env.js';
import { SETTINGS_CATEGORIES, SETTING_DESCRIPTIONS, } from './settings-completion-config.js';
import { buildSettingsList, clampIndex, filterSettingsByCategory, filterSettingsByQuery, getSettingCategory, } from './settings-completion-logic.js';
/**
 * Rows the settings list may use: the terminal height minus the chrome around
 * the list (prompt, tab bar, detail block, hints, status line).
 */
export function getSettingsVisibleCount(rows = process.stdout.rows ?? 24) {
    return Math.max(5, Math.min(20, rows - 14));
}
function sameValue(a, b) {
    if (a === b)
        return true;
    // An empty string, an absent value, and the literal "default" (reasoning
    // efforts) all mean "not set".
    const isUnset = (value) => value === undefined || value === '' || value === 'default';
    if (isUnset(a) && isUnset(b))
        return true;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    catch {
        return false;
    }
}
/**
 * Get the current value of a setting for display in the menu
 */
function getCurrentSettingValue(settingsService, key) {
    try {
        return settingsService.getDynamic(key);
    }
    catch {
        return undefined;
    }
}
function getSettingSource(settingsService, key) {
    try {
        return settingsService.getSource(key);
    }
    catch {
        return undefined;
    }
}
function getStartupOverride(settingsService, key) {
    try {
        const source = settingsService.getStartupOverride(key);
        if (!source)
            return undefined;
        return { source, name: source === 'env' ? SETTING_ENV_VARIABLES[key] : undefined };
    }
    catch {
        return undefined;
    }
}
function isModifiedFromDefault(settingsService, key, value) {
    try {
        return !sameValue(value, settingsService.getDefault(key));
    }
    catch {
        return false;
    }
}
function isRuntimeModifiable(settingsService, key) {
    try {
        return settingsService.isRuntimeModifiable(key);
    }
    catch {
        return true;
    }
}
export { SETTINGS_CATEGORIES, getSettingCategory, buildSettingsList, filterSettingsByQuery, filterSettingsByCategory, clampIndex, };
export const useSettingsCompletion = (settingsService) => {
    const { mode, input, cursorOffset, triggerIndex, controller } = useInputContext();
    const controllerFrame = controller.getSnapshot().stack.at(-1);
    const isControllerOpen = controllerFrame?.kind === 'settings';
    const isOpen = isControllerOpen || mode === 'settings_completion';
    // While the settings graph is controller-owned, the binding is the source
    // of truth for both the query and the replacement start. Keep the legacy
    // triggerIndex projection for callers that still use this hook directly.
    const activeTriggerIndex = isControllerOpen ? controllerFrame.binding.replacement.start : triggerIndex;
    // Derive query from input + triggerIndex
    const query = useMemo(() => {
        if (!isOpen)
            return '';
        if (isControllerOpen)
            return controllerFrame.binding.query;
        if (triggerIndex === null)
            return '';
        // triggerIndex is the end of "/settings " prefix
        if (triggerIndex > input.length)
            return '';
        const end = Math.min(cursorOffset, input.length);
        return input.slice(triggerIndex, end);
    }, [isOpen, isControllerOpen, controllerFrame, triggerIndex, input, cursorOffset]);
    const [settingsVersion, setSettingsVersion] = useState(0);
    // Refresh the list whenever a setting changes so currentValue stays accurate
    useEffect(() => {
        const unsubscribe = settingsService.onChange(() => {
            setSettingsVersion((prev) => prev + 1);
        });
        return unsubscribe;
    }, [settingsService]);
    const allSettings = useMemo(() => {
        return buildSettingsList(SETTING_KEYS, SETTING_DESCRIPTIONS, true, (key) => getCurrentSettingValue(settingsService, key)).map((item) => ({
            ...item,
            source: getSettingSource(settingsService, item.key),
            isModified: isModifiedFromDefault(settingsService, item.key, item.currentValue),
            startupOverride: getStartupOverride(settingsService, item.key),
            requiresRestart: !isRuntimeModifiable(settingsService, item.key),
        }));
        // settingsVersion is a signal dep — incrementing it triggers re-computation
        // when an external setting changes.  Omitted from the dependency lint check
        // because it does not appear literally in the memo body.
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [settingsService, settingsVersion]);
    const categories = useMemo(() => {
        const presentCategoryIds = new Set(allSettings.map((item) => getSettingCategory(item.key)?.id));
        return SETTINGS_CATEGORIES.filter((category) => presentCategoryIds.has(category.id));
    }, [allSettings]);
    const [activeCategoryId, setActiveCategoryId] = useState(() => SETTINGS_CATEGORIES[0]?.id ?? 'model');
    const resolvedActiveCategoryId = useMemo(() => {
        if (categories.some((category) => category.id === activeCategoryId)) {
            return activeCategoryId;
        }
        return categories[0]?.id ?? activeCategoryId;
    }, [activeCategoryId, categories]);
    const isSearchingAll = query.trim().length > 0;
    const filteredEntries = useMemo(() => {
        const candidateSettings = isSearchingAll
            ? allSettings
            : filterSettingsByCategory(allSettings, resolvedActiveCategoryId);
        return filterSettingsByQuery(candidateSettings, query, candidateSettings.length);
    }, [allSettings, isSearchingAll, query, resolvedActiveCategoryId]);
    const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } = useSelection(filteredEntries);
    const [scrollOffset, setScrollOffset] = useState(0);
    const [targetKey, setTargetKey] = useState(null);
    useEffect(() => {
        setScrollOffset(0); // eslint-disable-line react-hooks/set-state-in-effect
        setSelectedIndex(0);
    }, [query, setSelectedIndex]);
    const switchCategory = useCallback((direction = 'next') => {
        if (categories.length === 0)
            return;
        const currentIndex = Math.max(0, categories.findIndex((category) => category.id === resolvedActiveCategoryId));
        const delta = direction === 'next' ? 1 : -1;
        const nextIndex = (currentIndex + delta + categories.length) % categories.length;
        const nextCategory = categories[nextIndex];
        if (!nextCategory)
            return;
        setActiveCategoryId(nextCategory.id);
        setSelectedIndex(0);
        setScrollOffset(0);
    }, [categories, resolvedActiveCategoryId, setSelectedIndex]);
    const visibleCount = getSettingsVisibleCount();
    useEffect(() => {
        if (selectedIndex < scrollOffset) {
            setScrollOffset(selectedIndex); // eslint-disable-line react-hooks/set-state-in-effect
        }
        else if (selectedIndex >= scrollOffset + visibleCount) {
            setScrollOffset(selectedIndex - visibleCount + 1);
        }
    }, [selectedIndex, scrollOffset, visibleCount]);
    // Effect to select a target key once it appears in filteredEntries
    useEffect(() => {
        /* eslint-disable react-hooks/set-state-in-effect */
        if (targetKey && filteredEntries.length > 0) {
            const index = filteredEntries.findIndex((item) => item.key === targetKey);
            if (index !== -1) {
                setSelectedIndex(index);
                setTargetKey(null);
            }
        }
        /* eslint-enable react-hooks/set-state-in-effect */
    }, [filteredEntries, targetKey, setSelectedIndex]);
    const open = useCallback((startIndex, initialSelectionKey) => {
        const editor = controller.getSnapshot().editor;
        controller.replaceText(editor.text, Math.max(editor.cursor, startIndex));
        if (initialSelectionKey) {
            const category = getSettingCategory(initialSelectionKey);
            if (category)
                setActiveCategoryId(category.id);
            setTargetKey(initialSelectionKey);
        }
        else {
            setSelectedIndex(0);
        }
        setScrollOffset(0);
    }, [controller, setSelectedIndex]);
    const close = useCallback(() => {
        if (mode === 'settings_completion') {
            controller.close();
            setSelectedIndex(0);
            setScrollOffset(0);
        }
    }, [mode, controller, setSelectedIndex]);
    return {
        isOpen,
        triggerIndex: activeTriggerIndex, // Compatibility projection for legacy callers
        query,
        allSettings,
        filteredEntries,
        selectedIndex,
        scrollOffset,
        isSearchingAll,
        categories,
        activeCategoryId: resolvedActiveCategoryId,
        visibleCount,
        getDefaultValue: (key) => settingsService.getDefault(key),
        open,
        close,
        // updateQuery,
        moveUp,
        moveDown,
        moveHome,
        moveEnd,
        pageUp,
        pageDown,
        moveLeft: () => switchCategory('prev'),
        moveRight: () => switchCategory('next'),
        switchCategory,
        getSelectedItem,
    };
};
//# sourceMappingURL=use-settings-completion.js.map