/**
 * config/ — settings and profiles.
 *
 * Sits beside the layer stack: any layer may read it, and it depends on no
 * other layer. Layers receive a scoped `SettingsReader` instead of reaching
 * for a global, so a session can run with settings isolated from its host.
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
