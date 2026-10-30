import { createAdoptedSettings, type AdoptedSettingsOptions } from '../config/adopted/settings.js';

export type AppSettingsOptions = AdoptedSettingsOptions;
export type AppSettings = ReturnType<typeof createAdoptedSettings>;

/** Builds the legacy settings owner and its rewrite adapter at the app boundary. */
export function createAppSettings(options: AppSettingsOptions = {}): AppSettings {
  return createAdoptedSettings(options);
}
