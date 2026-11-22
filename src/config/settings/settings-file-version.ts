/**
 * The `version` field of `settings.json` and the ordered, loader-owned list of
 * migrations between file versions.
 *
 * A file without `version` is version 0: every file written before the field
 * existed (Term2 1.4.0 and earlier). Version 1 has the same content format as
 * version 0, so its migration only stamps the number. A change to what
 * `settings.json` holds that an older build would misread gets the next
 * version and an entry in {@link SETTINGS_FILE_MIGRATIONS}; the loader runs the
 * entries from the file's version up to {@link SETTINGS_FILE_VERSION} before
 * schema validation, and the writer always stamps the current version.
 *
 * The shape-detected normalizations in `loadSettingsFromFile` and
 * `SettingsService` (retired `advisory` approval mode, legacy model selections,
 * legacy provider records, ancillary settings) stay outside this list. They run
 * on every load whatever the version, because a version-0 file may hold any of
 * those shapes and a hand-edited current file may too.
 *
 * A file whose version is newer than this build knows is refused, unchanged:
 * this build cannot tell which of its values it would misread, and writing it
 * back would downgrade it. The conversation log refuses an unknown `v` the same
 * way.
 */

/** The version this build writes. Raise it only together with a new migration entry. */
export const SETTINGS_FILE_VERSION = 1;

/** The top-level `settings.json` key that holds the file version. It is not a setting. */
const SETTINGS_FILE_VERSION_KEY = 'version';

type RawSettings = Record<string, unknown>;

type SettingsFileMigration = {
  readonly from: number;
  readonly to: number;
  /** Turns a file at `from` (with its `version` key already removed) into one at `to`. */
  readonly migrate: (raw: RawSettings) => RawSettings;
};

/** Ordered by `from`; each entry moves exactly one version, and the last ends at {@link SETTINGS_FILE_VERSION}. */
export const SETTINGS_FILE_MIGRATIONS: readonly SettingsFileMigration[] = [
  // 0 -> 1: the version field was introduced. The content format did not change.
  { from: 0, to: 1, migrate: (raw) => raw },
];

export type SettingsFileVersionResult =
  | {
      readonly ok: true;
      /** The file content without its `version` key, migrated to the current version. */
      readonly content: unknown;
      /** The version the file was read at (0 when it had no `version`). */
      readonly fromVersion: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'newer' | 'invalid';
      /** A sentence for the user that names the version found and the supported one. */
      readonly message: string;
    };

const isRecord = (value: unknown): value is RawSettings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Read the version of parsed `settings.json` content and migrate it to the
 * current version. Content that is not a JSON object is returned unchanged so
 * schema validation reports it as before.
 */
export function migrateSettingsFileVersion(parsed: unknown): SettingsFileVersionResult {
  if (!isRecord(parsed)) return { ok: true, content: parsed, fromVersion: 0 };

  const hasVersion = Object.hasOwn(parsed, SETTINGS_FILE_VERSION_KEY);
  const found = parsed[SETTINGS_FILE_VERSION_KEY];
  if (hasVersion && !(typeof found === 'number' && Number.isSafeInteger(found) && found >= 0)) {
    return {
      ok: false,
      reason: 'invalid',
      message: `"${SETTINGS_FILE_VERSION_KEY}" is ${JSON.stringify(
        found,
      )}; it must be a whole number from 0 to ${SETTINGS_FILE_VERSION}.`,
    };
  }
  const fromVersion = hasVersion ? (found as number) : 0;
  if (fromVersion > SETTINGS_FILE_VERSION) {
    return {
      ok: false,
      reason: 'newer',
      message:
        `it is settings version ${fromVersion}, written by a newer Term2; this build reads settings up to ` +
        `version ${SETTINGS_FILE_VERSION}. Upgrade Term2, or move the file aside to start with default settings.`,
    };
  }

  let content: RawSettings = { ...parsed };
  delete content[SETTINGS_FILE_VERSION_KEY];
  for (let version = fromVersion; version < SETTINGS_FILE_VERSION; version++) {
    const step = SETTINGS_FILE_MIGRATIONS.find((migration) => migration.from === version);
    if (!step || step.to !== version + 1) {
      throw new Error(`No settings migration from version ${version} to ${version + 1}`);
    }
    content = step.migrate(content);
  }
  return { ok: true, content, fromVersion };
}
