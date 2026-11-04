/** The app's one settings owner: the source `SettingsService`. Sessions build their own runtime generations from it. */
import { SettingsService } from '../../../source/services/settings/settings-service.js';

export type AppSettingsOptions = NonNullable<ConstructorParameters<typeof SettingsService>[0]>;
export type { SettingsService };

export function createSettingsService(options: AppSettingsOptions = {}): SettingsService {
  return new SettingsService(options);
}
