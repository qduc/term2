/**
 * config/ — the settings reader contract.
 *
 * Any layer may read it, and it depends on no other layer. Tools receive a
 * `SettingsReader` in their `ToolContext` instead of reaching for a global, so
 * a session runs with its own settings. The concrete settings service (and
 * profiles) are source's, constructed in `app/settings.ts`; see README.md.
 */

export type SettingKey = string & { readonly __brand: 'SettingKey' };

export type SettingValue =
  | string
  | number
  | boolean
  | null
  | readonly SettingValue[]
  | { readonly [key: string]: SettingValue };

export type SettingsChange = {
  readonly key: SettingKey;
  readonly previous: SettingValue | undefined;
  readonly next: SettingValue | undefined;
};

export interface SettingsReader {
  get(key: SettingKey): SettingValue | undefined;
  /** Returns an unsubscribe function. */
  watch(listener: (change: SettingsChange) => void): () => void;
}
