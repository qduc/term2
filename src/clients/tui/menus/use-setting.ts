import { useState, useEffect } from 'react';
import type { ModelSettings } from './model-catalog.js';

/** Setting subscription over the session's model settings handle. */

/**
 * Hook to subscribe to a specific setting value.
 * Updates the component whenever the setting changes.
 */
export function useSetting(settingsService: Pick<ModelSettings, 'get' | 'onChange'>, key: string): unknown {
  const [value, setValue] = useState<unknown>(() => settingsService.get(key));

  useEffect(() => {
    // Sync with external settings service — subscribe to changes so the
    // component re-renders when the relevant key is updated elsewhere.
    const unsubscribe = settingsService.onChange?.((changedKey) => {
      // optimized: only update if the relevant key changed
      // simpler version: just check if the value actually changed
      if (!changedKey || changedKey === key || changedKey.startsWith(key + '.') || key.startsWith(changedKey + '.')) {
        const newValue = settingsService.get(key);
        setValue((prev: unknown) => {
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
