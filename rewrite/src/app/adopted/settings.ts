import { createAppSettings, type AppSettingsOptions } from '../settings.js';
import { createLegacySettingsSource } from '../../engine/adopted/settings.js';
import type { SettingsWriteMode } from '../../config/scoped-settings.js';

/** Historical bench composition; native startup never allocates this compatibility view. */
export function createLegacyAppSettings(options: AppSettingsOptions & { readonly writeMode?: SettingsWriteMode } = {}) {
  const { writeMode = 'persistent', ...serviceOptions } = options;
  const { service } = createAppSettings(serviceOptions);
  return { service, source: createLegacySettingsSource(service, writeMode) };
}
