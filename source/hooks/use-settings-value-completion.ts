import { useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { useSelection } from './use-selection.js';
import { buildSettingValueSuggestions, filterSettingValueSuggestionsByQuery } from '../utils/value-suggestions.js';
import { isNumberSetting, isSecretSetting, isStringSetting } from '../services/settings/settings-ui-metadata.js';

const MAX_RESULTS = 10;

export const useSettingsValueCompletion = (settingsService: SettingsService) => {
  const { controller } = useInputContext();

  const controllerFrame = controller.getSnapshot().stack.at(-1);
  const isControllerOpen = controllerFrame?.kind === 'settings_value';
  const isOpen = isControllerOpen;

  const [settingsVersion, setSettingsVersion] = useState(0);

  const resolvedSettingKey = isControllerOpen ? controllerFrame.settingKey : null;

  // Recompute current setting value suggestions when settings change.
  // (Useful if we later want to add "current" or dynamic suggestions.)
  useEffect(() => {
    const unsubscribe = settingsService.onChange(() => {
      setSettingsVersion((v) => v + 1);
    });
    return unsubscribe;
  }, [settingsService]);

  const query = useMemo(() => {
    if (!isControllerOpen) return '';
    return controllerFrame.binding.query;
  }, [isControllerOpen, controllerFrame]);

  const allSuggestions = useMemo(() => {
    if (!resolvedSettingKey) return [];
    // settingsVersion is used to allow refresh when values change.
    void settingsVersion;
    const suggestions = [...buildSettingValueSuggestions(resolvedSettingKey)];
    // Never surface a stored credential as a suggestion.
    if (isSecretSetting(resolvedSettingKey)) return suggestions;
    try {
      const currentValue = settingsService.getDynamic(resolvedSettingKey);
      if (currentValue !== undefined) {
        const currentValueStr = String(currentValue);
        if (!suggestions.some((s) => s.value === currentValueStr)) {
          suggestions.unshift({
            value: currentValueStr,
            description: 'Current value',
          });
        }
      }
    } catch {
      // Ignore
    }
    return suggestions;
  }, [resolvedSettingKey, settingsVersion, settingsService]);

  const filteredEntries = useMemo(() => {
    return filterSettingValueSuggestionsByQuery(allSuggestions, query, MAX_RESULTS, resolvedSettingKey ?? undefined);
  }, [allSuggestions, query, resolvedSettingKey]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredEntries);

  // Controller-owned value menus do not call the legacy `open()` initializer.
  // Initialize them from the active setting so `/effort` starts on the value
  // that will actually be used, rather than always highlighting the first
  // suggestion.
  useEffect(() => {
    if (!isControllerOpen || !resolvedSettingKey) return;
    try {
      const currentValue = settingsService.getDynamic(resolvedSettingKey);
      const currentValueIndex = filteredEntries.findIndex((item) => item.value === String(currentValue));
      setSelectedIndex(currentValueIndex >= 0 ? currentValueIndex : 0);
    } catch {
      setSelectedIndex(0);
    }
  }, [isControllerOpen, controllerFrame?.id, resolvedSettingKey, filteredEntries, settingsService, setSelectedIndex]);

  const isNumericSettings = useMemo(() => {
    return resolvedSettingKey ? isNumberSetting(resolvedSettingKey) : false;
  }, [resolvedSettingKey]);

  // Free-form string: string setting with no predefined suggestions.
  // These are settings like api keys, model names, hostnames, etc.
  // Users should type a value freely; the empty state should not show an error.
  const isFreeFormString = useMemo(() => {
    if (!resolvedSettingKey) return false;
    if (!isStringSetting(resolvedSettingKey)) return false;
    return buildSettingValueSuggestions(resolvedSettingKey).length === 0;
  }, [resolvedSettingKey]);

  return {
    isOpen,
    query,
    filteredEntries,
    selectedIndex,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    pageUp,
    pageDown,
    getSelectedItem,
    isNumericSettings,
    isFreeFormString,
  };
};
