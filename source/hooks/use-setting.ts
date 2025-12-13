import {useState, useEffect} from 'react';
import type {SettingsService} from '../services/settings-service.js';

/**
 * Hook to subscribe to a specific setting value.
 * Updates the component whenever the setting changes.
 */
export function useSetting<T>(settingsService: SettingsService, key: string): T {
    const [value, setValue] = useState<T>(() => settingsService.get<T>(key));

    useEffect(() => {
        // Ensure we have the latest value on mount/update
        const currentValue = settingsService.get<T>(key);
        if (currentValue !== value) {
            setValue(currentValue);
        }

        const unsubscribe = settingsService.onChange((changedKey) => {
            // optimized: only update if the relevant key changed
            // simpler version: just check if the value actually changed
            if (
                !changedKey ||
                changedKey === key ||
                changedKey.startsWith(key + '.') ||
                key.startsWith(changedKey + '.')
            ) {
                const newValue = settingsService.get<T>(key);
                setValue(prev => {
                    // Simple equality check to avoid rerenders if value hasn't effectively changed
                    if (JSON.stringify(prev) !== JSON.stringify(newValue)) {
                        return newValue;
                    }
                    return prev;
                });
            }
        });

        return unsubscribe;
    }, [key]);

    return value;
}
