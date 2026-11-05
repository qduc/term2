/**
 * The legacy settings-menu library (schema metadata, list logic, value
 * suggestions), supplied by the app through `TuiMenus.settings.lib`. The ported
 * settings files import these names from here instead of from source/, so
 * their bodies stay as legacy wrote them. The menu host installs the library
 * before any settings frame can render; it is process-wide static schema code.
 */
import type { TuiSettingsLibrary } from '../integration.js';

export type { SettingCompletionItem, SettingsCategory, SettingValueSuggestion } from '../integration.js';

let installed: TuiSettingsLibrary | undefined;

export function installSettingsLibrary(lib: TuiSettingsLibrary): void {
  installed = lib;
}

const lib = (): TuiSettingsLibrary => {
  if (!installed) throw new Error('The settings menu library is not installed.');
  return installed;
};

const record = <T extends object>(read: () => T): T =>
  new Proxy({} as T, {
    get: (_target, key) => Reflect.get(read(), key),
    has: (_target, key) => Reflect.has(read(), key),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(read(), key),
  });

export const SETTING_KEYS = record(() => lib().SETTING_KEYS);
export const SETTING_ENV_VARIABLES = record(() => lib().SETTING_ENV_VARIABLES);
export const SETTING_DESCRIPTIONS = record(() => lib().SETTING_DESCRIPTIONS);
export const SETTINGS_CATEGORIES = record(() => lib().SETTINGS_CATEGORIES);

export const buildSettingsList: TuiSettingsLibrary['buildSettingsList'] = (...args) => lib().buildSettingsList(...args);
export const filterSettingsByQuery: TuiSettingsLibrary['filterSettingsByQuery'] = (...args) =>
  lib().filterSettingsByQuery(...args);
export const filterSettingsByCategory: TuiSettingsLibrary['filterSettingsByCategory'] = (...args) =>
  lib().filterSettingsByCategory(...args);
export const getSettingCategory = (key: string) => lib().getSettingCategory(key);
export const getSettingMetadata = (key: string) => lib().getSettingMetadata(key);
export const getSettingLabel = (key: string) => lib().getSettingLabel(key);
export const isSecretSetting = (key: string) => lib().isSecretSetting(key);
export const isStringSetting = (key: string) => lib().isStringSetting(key);
export const isNumberSetting = (key: string) => lib().isNumberSetting(key);
export const isBooleanSetting = (key: string) => lib().isBooleanSetting(key);
export const isDurationSetting = (key: string) => lib().isDurationSetting(key);
export const isUsdMicrosSetting = (key: string) => lib().isUsdMicrosSetting(key);
export const buildSettingValueSuggestions = (key: string) => lib().buildSettingValueSuggestions(key);
export const fetchLiveSettingValueSuggestions = (key: string) => lib().fetchLiveSettingValueSuggestions(key);
export const mergeSettingValueSuggestions: TuiSettingsLibrary['mergeSettingValueSuggestions'] = (...args) =>
  lib().mergeSettingValueSuggestions(...args);
export const filterSettingValueSuggestionsByQuery: TuiSettingsLibrary['filterSettingValueSuggestionsByQuery'] = (
  ...args
) => lib().filterSettingValueSuggestionsByQuery(...args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const parseSettingValueForKey = (key: string, raw: string): any => lib().parseSettingValueForKey(key, raw);
