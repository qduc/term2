import { createDirectSettingsService, type DirectSettingsOptions } from './direct-config-settings.js';

export type AppSettingsOptions = DirectSettingsOptions;
export type AppSettings = { readonly service: ReturnType<typeof createDirectSettingsService> };

/** Builds only the concrete settings owner; native sessions own their runtime generations. */
export function createAppSettings(options: AppSettingsOptions = {}): AppSettings {
  return { service: createDirectSettingsService(options) };
}
