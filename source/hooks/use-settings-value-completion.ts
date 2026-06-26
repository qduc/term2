import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { useSelection } from './use-selection.js';
import { buildSettingValueSuggestions, filterSettingValueSuggestionsByQuery } from '../utils/value-suggestions.js';
import { resolveSettingAtPath, unwrapSchema } from '../services/settings/setting-schema-utils.js';

const MAX_RESULTS = 10;

function isNumberSetting(key: string): boolean {
  const schema = resolveSettingAtPath(key);
  if (!schema) return false;
  const unwrapped = unwrapSchema(schema);
  if (!unwrapped) return false;
  return (unwrapped as any)._def?.type === 'number';
}

function isStringSetting(key: string): boolean {
  const schema = resolveSettingAtPath(key);
  if (!schema) return false;
  const unwrapped = unwrapSchema(schema);
  if (!unwrapped) return false;
  return (unwrapped as any)._def?.type === 'string';
}

export const useSettingsValueCompletion = (
  settingsService: SettingsService,
  options?: { onReset?: (key: string) => void },
) => {
  const { mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex } = useInputContext();

  const isOpen = mode === 'settings_value_completion';

  const [settingKey, setSettingKey] = useState<string | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);

  // Recompute current setting value suggestions when settings change.
  // (Useful if we later want to add "current" or dynamic suggestions.)
  useEffect(() => {
    const unsubscribe = settingsService.onChange(() => {
      setSettingsVersion((v) => v + 1);
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
    const suggestions = [...buildSettingValueSuggestions(settingKey)];
    try {
      const currentValue = settingsService.get(settingKey);
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
  }, [settingKey, settingsVersion, settingsService]);

  const filteredEntries = useMemo(() => {
    return filterSettingValueSuggestionsByQuery(allSuggestions, query, MAX_RESULTS, settingKey ?? undefined);
  }, [allSuggestions, query, settingKey]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredEntries);

  const open = useCallback(
    (key: string, valueStartIndex: number) => {
      if (mode === 'settings_value_completion' && settingKey === key) {
        return;
      }
      setSettingKey(key);
      setMode('settings_value_completion');
      setTriggerIndex(valueStartIndex);

      // Get current value from settingsService and find it in suggestions
      try {
        const currentValue = settingsService.get(key);
        if (currentValue !== undefined) {
          const currentValueStr = String(currentValue);
          const suggestions = buildSettingValueSuggestions(key);
          const hasCurrent = suggestions.some((s) => s.value === currentValueStr);

          if (hasCurrent) {
            const index = suggestions.findIndex((s) => s.value === currentValueStr);
            setSelectedIndex(index >= 0 ? index : 0);
          } else {
            // Since it's not in suggestions, it will be prepended as "Current value" at index 0.
            setSelectedIndex(0);
          }
        } else {
          setSelectedIndex(0);
        }
      } catch {
        // If there's an error getting the value, default to first item
        setSelectedIndex(0);
      }
    },
    [mode, setMode, setTriggerIndex, settingKey, settingsService, setSelectedIndex],
  );

  const close = useCallback(() => {
    if (mode === 'settings_value_completion') {
      setMode('text');
      setTriggerIndex(null);
      setSelectedIndex(0);
      setSettingKey(null);
    }
  }, [mode, setMode, setTriggerIndex, setSelectedIndex]);

  const resetCurrentSetting = useCallback(() => {
    if (settingKey) {
      const key = settingKey;
      settingsService.reset(key);
      close();
      options?.onReset?.(key);
    } else {
      close();
    }
  }, [settingKey, settingsService, close, options]);

  const isNumericSettings = useMemo(() => {
    return settingKey ? isNumberSetting(settingKey) : false;
  }, [settingKey]);

  // Free-form string: string setting with no predefined suggestions.
  // These are settings like api keys, model names, hostnames, etc.
  // Users should type a value freely; the empty state should not show an error.
  const isFreeFormString = useMemo(() => {
    if (!settingKey) return false;
    if (!isStringSetting(settingKey)) return false;
    return buildSettingValueSuggestions(settingKey).length === 0;
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
    resetCurrentSetting,
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
