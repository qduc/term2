import { useCallback, useEffect, useMemo, useState } from 'react';
import { SETTING_KEYS, type SettingsService } from '../services/settings/settings-service.js';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import {
  SETTINGS_CATEGORIES,
  SETTING_DESCRIPTIONS,
  type SettingCompletionItem,
  type SettingsCategory,
} from './settings-completion-config.js';
import {
  buildSettingsList,
  clampIndex,
  filterSettingsByCategory,
  filterSettingsByQuery,
  getSettingCategory,
} from './settings-completion-logic.js';

const MAX_RESULTS = 10;

/**
 * Get the current value of a setting for display in the menu
 */
function getCurrentSettingValue(settingsService: SettingsService, key: string): string | number | boolean | undefined {
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

export {
  SETTINGS_CATEGORIES,
  type SettingCompletionItem,
  type SettingsCategory,
  getSettingCategory,
  buildSettingsList,
  filterSettingsByQuery,
  filterSettingsByCategory,
  clampIndex,
};

export const useSettingsCompletion = (settingsService: SettingsService) => {
  const { mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex } = useInputContext();

  const isOpen = mode === 'settings_completion';

  // Derive query from input + triggerIndex
  const query = useMemo(() => {
    if (!isOpen || triggerIndex === null) return '';
    // triggerIndex is the end of "/settings " prefix
    if (triggerIndex > input.length) return '';
    const end = Math.min(cursorOffset, input.length);
    return input.slice(triggerIndex, end);
  }, [isOpen, triggerIndex, input, cursorOffset]);

  const [settingsVersion, setSettingsVersion] = useState(0);

  // Refresh the list whenever a setting changes so currentValue stays accurate
  useEffect(() => {
    const unsubscribe = settingsService.onChange(() => {
      setSettingsVersion((prev) => prev + 1);
    });
    return unsubscribe;
  }, [settingsService]);

  const allSettings = useMemo(() => {
    return buildSettingsList(SETTING_KEYS, SETTING_DESCRIPTIONS, true, (key: string) =>
      getCurrentSettingValue(settingsService, key),
    );
    // settingsVersion is a signal dep — incrementing it triggers re-computation
    // when an external setting changes.  Omitted from the dependency lint check
    // because it does not appear literally in the memo body.
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [settingsService, settingsVersion]);

  const categories = useMemo(() => {
    const presentCategoryIds = new Set(allSettings.map((item) => getSettingCategory(item.key).id));
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

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredEntries);
  const [scrollOffset, setScrollOffset] = useState(0);

  const [targetKey, setTargetKey] = useState<string | null>(null);

  useEffect(() => {
    setScrollOffset(0); // eslint-disable-line react-hooks/set-state-in-effect
  }, [query]);

  const switchCategory = useCallback(
    (direction: 'next' | 'prev' = 'next') => {
      if (categories.length === 0) return;

      const currentIndex = Math.max(
        0,
        categories.findIndex((category) => category.id === resolvedActiveCategoryId),
      );
      const delta = direction === 'next' ? 1 : -1;
      const nextIndex = (currentIndex + delta + categories.length) % categories.length;
      const nextCategory = categories[nextIndex];
      if (!nextCategory) return;

      setActiveCategoryId(nextCategory.id);
      setSelectedIndex(0);
      setScrollOffset(0);
    },
    [categories, resolvedActiveCategoryId, setSelectedIndex],
  );

  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex); // eslint-disable-line react-hooks/set-state-in-effect
    } else if (selectedIndex >= scrollOffset + MAX_RESULTS) {
      setScrollOffset(selectedIndex - MAX_RESULTS + 1);
    }
  }, [selectedIndex, scrollOffset]);

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

  const open = useCallback(
    (startIndex: number, initialSelectionKey?: string) => {
      // If already in settings mode, do not reset selection.
      if (mode === 'settings_completion') return;
      setMode('settings_completion');
      setTriggerIndex(startIndex);
      if (initialSelectionKey) {
        setActiveCategoryId(getSettingCategory(initialSelectionKey).id);
        setTargetKey(initialSelectionKey);
      } else {
        setSelectedIndex(0);
      }
      setScrollOffset(0);
    },
    [mode, setMode, setTriggerIndex, setSelectedIndex],
  );

  const close = useCallback(() => {
    if (mode === 'settings_completion') {
      setMode('text');
      setTriggerIndex(null);
      setSelectedIndex(0);
      setScrollOffset(0);
    }
  }, [mode, setMode, setTriggerIndex, setSelectedIndex]);

  return {
    isOpen,
    triggerIndex,
    query,
    filteredEntries,
    selectedIndex,
    scrollOffset,
    isSearchingAll,
    categories,
    activeCategoryId: resolvedActiveCategoryId,
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
