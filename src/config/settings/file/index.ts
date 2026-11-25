/**
 * The on-disk format of `settings.json`: where its bytes are read and written
 * (lock, atomic replacement, corrupt-file salvage and quarantine), its `version`
 * and the migrations between versions, and which defaults the file may leave out.
 * `SettingsService` (src/app/settings-service.ts) is the one caller; Contract 10
 * (docs/contracts/10-settings-durability-migration-and-sensitive-bytes.md) states
 * the guarantees.
 */
export {
  hasMissingKeys,
  loadSettingsFromFile,
  saveSettingsToFile,
  stripSensitiveSettings,
} from './settings-persistence.js';
export { quarantineCorruptSettingsFile } from './settings-file-recovery.js';
export { SETTINGS_FILE_VERSION } from './settings-file-version.js';
export {
  OPTIONAL_DEFAULT_KEYS,
  cleanImplicitDefaults,
  implicitAgentDefaults,
  type ComputedDefaultIntent,
} from './persisted-defaults.js';
