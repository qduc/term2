import type { SettingKey, SettingValue, SettingsChange, SettingsReader } from './index.js';

/** Fixed in-memory settings. Enough for the tracer; no persistence or scoping. */
export function memorySettings(values: Readonly<Record<string, SettingValue>> = {}): SettingsReader {
  const map = new Map<string, SettingValue>(Object.entries(values));
  return {
    get: (key: SettingKey) => map.get(key),
    watch: (_listener: (change: SettingsChange) => void) => () => {},
  };
}
