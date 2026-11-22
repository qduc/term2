import fs from 'node:fs';
import path from 'node:path';
import deepEqual from 'fast-deep-equal';

import type { ZodTypeAny } from 'zod';
import type { SettingsData } from '../settings-schema.js';
import { mergeSettings } from '../settings-merger.js';
import { unwrapSchema } from '../setting-schema-utils.js';
import { acquireSettingsLock, type LockOptions } from './settings-file-lock.js';
import { scanForRecoverableJson, type SettingsFileRecovery } from './settings-file-recovery.js';
import { migratePersistedSelections } from './persisted-selection-migration.js';
import { SETTINGS_FILE_VERSION, migrateSettingsFileVersion } from './settings-file-version.js';

type LoggerLike = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

type SettingsMutation = (current: SettingsData) => SettingsData;

/**
 * Try to parse each top-level section of the settings object independently.
 * Valid sections are included in the result; invalid sections are omitted so
 * they fall back to defaults in mergeSettings. The file on disk is never touched.
 */
function parsePartialSections(parsed: unknown, schema: ZodTypeAny): Partial<SettingsData> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;

  const objectSchema = unwrapSchema(schema);
  if (!objectSchema?.shape || typeof objectSchema.shape !== 'object') return {};
  const shape = objectSchema.shape as Record<string, ZodTypeAny>;

  const partial: Record<string, unknown> = {};
  for (const [key, sectionSchema] of Object.entries(shape)) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const result = sectionSchema.safeParse(record[key]);
    if (result.success) {
      partial[key] = result.data;
    }
  }
  return partial as Partial<SettingsData>;
}

export function loadSettingsFromFile(opts: {
  settingsDir: string;
  schema: ZodTypeAny;
  disableLogging?: boolean;
  loggingService?: LoggerLike;
}): {
  validated: Partial<SettingsData>;
  raw: unknown;
  hadErrors: boolean;
  errorDetails?: string[];
  recovery?: SettingsFileRecovery;
  migratedSelections?: boolean;
  migratedApprovalPolicy?: boolean;
  /** The file's `version` before migration (0 for a file without one); absent when there is no file. */
  fileVersion?: number;
  /**
   * Set when the file's `version` is newer than this build or not a valid number. The file is
   * refused unchanged: there is no salvage, partial load or rewrite, and the writer will not replace it.
   */
  versionRefusal?: string;
} {
  try {
    const settingsFile = path.join(opts.settingsDir, 'settings.json');

    if (!fs.existsSync(settingsFile)) {
      return { validated: {}, raw: {}, hadErrors: false };
    }

    const content = fs.readFileSync(settingsFile, 'utf-8');

    let parsed: unknown;
    let recovery: SettingsFileRecovery | undefined;
    let errorDetails: string[] = [];
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      const syntaxError = error instanceof Error ? error.message : String(error);
      const scanned = scanForRecoverableJson(content);
      if (!scanned) {
        if (!opts.disableLogging) {
          opts.loggingService?.error('Failed to load settings file', {
            error: syntaxError,
            settingsFile,
          });
        }
        return { validated: {}, raw: {}, hadErrors: true, errorDetails: [syntaxError] };
      }
      parsed = scanned.recovered;
      errorDetails = [syntaxError];
      recovery = {
        recovered: true,
        reason: `invalid JSON syntax (${syntaxError}); ${scanned.reason}`,
        recoveredSectionKeys: Object.keys(scanned.recovered as Record<string, unknown>),
      };
      if (!opts.disableLogging) {
        opts.loggingService?.warn('Recovered settings content from a corrupt file', {
          settingsFile,
          reason: recovery.reason,
          recoveredSectionKeys: recovery.recoveredSectionKeys,
        });
      }
    }

    // The file version is checked before anything else reads the content, on the
    // clean and the salvaged path alike: a newer file is refused whole.
    const versioned = migrateSettingsFileVersion(parsed);
    if (!versioned.ok) {
      const refusal = `Settings file at ${settingsFile} cannot be read: ${versioned.message} The file was not changed.`;
      if (!opts.disableLogging) {
        opts.loggingService?.error('Refusing a settings file version this build does not support', {
          settingsFile,
          reason: versioned.reason,
          supportedVersion: SETTINGS_FILE_VERSION,
        });
      }
      return { validated: {}, raw: {}, hadErrors: true, errorDetails: [refusal], versionRefusal: refusal };
    }
    parsed = versioned.content;
    const fileVersion = versioned.fromVersion;

    // Both startup and locked save reloads pass this file-only boundary.
    // Retired advisory is accepted here before validation, while raw input stays
    // intact for migration detection and diagnosis.
    const shell = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).shell : undefined;
    const migratedApprovalPolicy =
      shell != null && typeof shell === 'object' && (shell as Record<string, unknown>).autoApproveMode === 'advisory';
    const migratedInput = migratedApprovalPolicy
      ? { ...(parsed as Record<string, unknown>), shell: { ...shell, autoApproveMode: 'off', showReview: true } }
      : parsed;
    let migration: ReturnType<typeof migratePersistedSelections>;
    try {
      migration = migratePersistedSelections(migratedInput);
    } catch (error: unknown) {
      return {
        validated: parsePartialSections(migratedInput, opts.schema),
        raw: parsed,
        hadErrors: true,
        errorDetails: [...errorDetails, error instanceof Error ? error.message : String(error)],
        recovery,
        fileVersion,
      };
    }
    const validated = opts.schema.safeParse(migration.value);

    if (!validated.success) {
      const schemaIssues = validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      if (!opts.disableLogging) {
        opts.loggingService?.warn('Settings file contains invalid values', {
          errors: validated.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      // Preserve valid top-level sections; invalid sections fall back to defaults
      // via mergeSettings. The file is left unchanged for the user to fix.
      return {
        validated: parsePartialSections(migration.value, opts.schema),
        raw: parsed,
        hadErrors: true,
        errorDetails: [...errorDetails, ...schemaIssues],
        recovery,
        fileVersion,
      };
    }

    return {
      validated: validated.data as Partial<SettingsData>,
      raw: parsed,
      // A recovered file still had errors: the caller must not treat a salvage
      // as a clean load (for example by overwriting the corrupt file in place).
      hadErrors: recovery !== undefined,
      errorDetails: recovery ? errorDetails : undefined,
      recovery,
      migratedSelections: migration.migrated,
      migratedApprovalPolicy,
      fileVersion,
    };
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!opts.disableLogging) {
      opts.loggingService?.error('Failed to load settings file', {
        error: errorMsg,
        settingsFile: path.join(opts.settingsDir, 'settings.json'),
      });
    }

    return { validated: {}, raw: {}, hadErrors: true, errorDetails: [errorMsg] };
  }
}

export function saveSettingsToFile(opts: {
  settingsDir: string;
  schema: ZodTypeAny;
  defaults: SettingsData;
  mutate: SettingsMutation;
  /** Raw configuration is read under the same lock as serialization. */
  stripSensitiveSettings: (settings: SettingsData, raw?: unknown) => Partial<SettingsData>;
  disableLogging?: boolean;
  loggingService?: LoggerLike;
  lockOptions?: LockOptions;
}): SettingsData | undefined {
  try {
    const settingsFile = path.join(opts.settingsDir, 'settings.json');

    // Ensure directory exists
    if (!fs.existsSync(opts.settingsDir)) {
      fs.mkdirSync(opts.settingsDir, { recursive: true });
    }

    const releaseLock = acquireSettingsLock(opts.settingsDir, opts.lockOptions);
    try {
      const loaded = loadSettingsFromFile({
        settingsDir: opts.settingsDir,
        schema: opts.schema,
        disableLogging: opts.disableLogging,
        loggingService: opts.loggingService,
      });
      if (loaded.hadErrors) {
        throw new Error(
          `Refusing to overwrite invalid settings file: ${loaded.errorDetails?.join('; ') ?? 'unknown error'}`,
        );
      }

      const current = mergeSettings(
        opts.defaults,
        loaded.validated,
        {},
        {},
        {
          disableLogging: opts.disableLogging,
          loggingService: opts.loggingService,
        },
      );
      const next = opts.mutate(structuredClone(current));
      const validation = opts.schema.safeParse(next);
      if (!validation.success) {
        throw new Error(
          `Refusing to save invalid settings: ${validation.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      // The writer always stamps the version it wrote the content in; the loader
      // has already migrated an older file to it and refused a newer one above.
      const settingsToSave = { version: SETTINGS_FILE_VERSION, ...opts.stripSensitiveSettings(next, loaded.raw) };
      const newContent = JSON.stringify(settingsToSave, null, 2);

      // Only write if file doesn't exist or content has changed. Compare parsed
      // objects rather than text so formatting never causes a rewrite.
      if (fs.existsSync(settingsFile)) {
        try {
          const existingContent = fs.readFileSync(settingsFile, 'utf-8');
          const existingParsed: unknown = JSON.parse(existingContent);

          if (deepEqual(existingParsed, settingsToSave)) {
            return next;
          }
        } catch {
          // The load above would have rejected an invalid existing file. This
          // is only a last-moment external replacement; writing a new atomic
          // snapshot is still safer than a direct truncating write.
        }
      }

      const tempFile = path.join(
        opts.settingsDir,
        `settings.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
      );
      let tempFileCreated = false;
      try {
        const tempFd = fs.openSync(tempFile, 'wx');
        tempFileCreated = true;
        try {
          fs.writeFileSync(tempFd, newContent, 'utf-8');
          fs.fsyncSync(tempFd);
        } finally {
          fs.closeSync(tempFd);
        }
        fs.renameSync(tempFile, settingsFile);
        tempFileCreated = false;
      } finally {
        if (tempFileCreated) {
          try {
            fs.unlinkSync(tempFile);
          } catch {
            // Best effort only: preserve the original write/rename failure.
          }
        }
      }
      return next;
    } finally {
      releaseLock();
    }
  } catch (error: unknown) {
    if (!opts.disableLogging) {
      opts.loggingService?.error('Failed to save settings file', {
        error: error instanceof Error ? error.message : String(error),
        settingsFile: path.join(opts.settingsDir, 'settings.json'),
      });
    }
    return undefined;
  }
}

/**
 * Remove sensitive settings that should never be persisted to disk.
 */
export function stripSensitiveSettings(settings: SettingsData): Partial<SettingsData> {
  const cleaned: Partial<SettingsData> = JSON.parse(JSON.stringify(settings));

  // Remove sensitive openrouter fields (keep non-secret config)
  if (cleaned.agent?.openrouter) {
    delete cleaned.agent.openrouter.baseUrl;
    delete cleaned.agent.openrouter.referrer;
    delete cleaned.agent.openrouter.title;
    // Only keep model if it's set (it's not sensitive)
    if (Object.keys(cleaned.agent.openrouter).length === 0) {
      delete cleaned.agent.openrouter;
    }
  }

  // Remove sensitive app settings
  if (cleaned.app) {
    delete cleaned.app.shellPath;
    // The canonical activeProfileId is persisted so it survives across sessions.
  }

  return cleaned;
}

/**
 * Check if target object is missing any keys that exist in source.
 */
export function hasMissingKeys(
  target: unknown,
  source: unknown,
  optionalDefaultKeys: Set<string>,
  prefix: string = '',
): boolean {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return true;

  const sourceObj = source as Record<string, unknown>;
  const targetObj = target as Record<string, unknown>;

  for (const key in sourceObj) {
    if (!Object.prototype.hasOwnProperty.call(sourceObj, key)) continue;

    const pathKey = prefix ? `${prefix}.${key}` : key;
    const sourceValue = sourceObj[key];

    if (!(key in targetObj)) {
      // Skip optional default keys when deciding whether to rewrite file
      if (optionalDefaultKeys.has(pathKey)) {
        continue;
      }
      // If the default value is undefined, treat it as optional for persistence
      if (typeof sourceValue === 'undefined') {
        continue;
      }
      return true;
    }
    const targetValue = targetObj[key];

    // Recursively check nested objects
    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      if (hasMissingKeys(targetValue, sourceValue, optionalDefaultKeys, pathKey)) {
        return true;
      }
    }
  }

  return false;
}
