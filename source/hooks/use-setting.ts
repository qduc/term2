import { useState, useEffect } from 'react';
import type { ISettingsService } from '../services/service-interfaces.js';
import type { SettingKey, SettingValue } from '../services/settings/settings-schema.js';

/**
 * Hook to subscribe to a specific setting value.
 * Updates the component whenever the setting changes.
 */
export function useSetting<K extends SettingKey>(settingsService: ISettingsService, key: K): SettingValue<K> {
  const [value, setValue] = useState<SettingValue<K>>(() => settingsService.get(key));

  useEffect(() => {
    // Sync with external settings service — subscribe to changes so the
    // component re-renders when the relevant key is updated elsewhere.
    const unsubscribe = settingsService.onChange?.((changedKey) => {
      // optimized: only update if the relevant key changed
      // simpler version: just check if the value actually changed
      if (!changedKey || changedKey === key || changedKey.startsWith(key + '.') || key.startsWith(changedKey + '.')) {
        const newValue = settingsService.get(key);
        setValue((prev) => {
          // Simple equality check to avoid rerenders if value hasn't effectively changed
          if (JSON.stringify(prev) !== JSON.stringify(newValue)) {
            return newValue;
          }
          return prev;
        });
      }
    });

    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return value;
}
