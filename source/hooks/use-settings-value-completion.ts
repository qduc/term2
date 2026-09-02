import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { useSelection } from './use-selection.js';
import {
  buildSettingValueSuggestions,
  filterSettingValueSuggestionsByQuery,
  isSecretSetting,
} from '../utils/value-suggestions.js';
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
  const { mode, input, cursorOffset, triggerIndex, controller } = useInputContext();

  const controllerFrame = controller.getSnapshot().stack.at(-1);
  const isControllerOpen = controllerFrame?.kind === 'settings_value';
  const isOpen = isControllerOpen || mode === 'settings_value_completion';

  const [settingKey, setSettingKey] = useState<string | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);

  // While the settings-value graph is controller-owned, the frame is the
  // source of truth for the setting key. Keep the legacy `settingKey` local
  // state (populated by the legacy `open()`) for callers that still use this
  // hook directly for a graph 4 (still-legacy) trigger.
  const resolvedSettingKey = isControllerOpen ? controllerFrame.settingKey : settingKey;

  // While the settings-value graph is controller-owned, the binding is the
  // source of truth for both the query and the replacement start. Keep the
  // legacy triggerIndex projection for callers that still use this hook
  // directly.
  const activeTriggerIndex = isControllerOpen ? controllerFrame.binding.replacement.start : triggerIndex;

  // Recompute current setting value suggestions when settings change.
  // (Useful if we later want to add "current" or dynamic suggestions.)
  useEffect(() => {
    const unsubscribe = settingsService.onChange(() => {
      setSettingsVersion((v) => v + 1);
    });
    return unsubscribe;
  }, [settingsService]);

  const query = useMemo(() => {
    if (!isOpen) return '';
    if (isControllerOpen) return controllerFrame.binding.query;
    if (triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return input.slice(triggerIndex, end);
  }, [isOpen, isControllerOpen, controllerFrame, triggerIndex, input, cursorOffset]);

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

  const open = useCallback(
    (key: string, valueStartIndex: number) => {
      setSettingKey(key);
      const editor = controller.getSnapshot().editor;
      controller.replaceText(editor.text, Math.max(editor.cursor, valueStartIndex));

      // Get current value from settingsService and find it in suggestions.
      // Secrets are never listed, so there is nothing to preselect.
      if (isSecretSetting(key)) {
        setSelectedIndex(0);
        return;
      }
      try {
        const currentValue = settingsService.getDynamic(key);
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
    [controller, settingsService, setSelectedIndex],
  );

  const close = useCallback(() => {
    if (mode === 'settings_value_completion') {
      controller.close();
      setSelectedIndex(0);
      setSettingKey(null);
    }
  }, [mode, controller, setSelectedIndex]);

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
    triggerIndex: activeTriggerIndex, // Compatibility projection for legacy callers
    settingKey: resolvedSettingKey,
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
