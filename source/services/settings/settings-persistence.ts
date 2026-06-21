import fs from 'node:fs';
import path from 'node:path';
import deepEqual from 'fast-deep-equal';

import type { ZodTypeAny } from 'zod';
import type { SettingsData } from './settings-schema.js';

type LoggerLike = {
  warn: (message: string, meta?: any) => void;
  error: (message: string, meta?: any) => void;
};

/**
 * Try to parse each top-level section of the settings object independently.
 * Valid sections are included in the result; invalid sections are omitted so
 * they fall back to defaults in mergeSettings. The file on disk is never touched.
 */
function parsePartialSections(parsed: any, schema: ZodTypeAny): Partial<SettingsData> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const shape = (schema as any).shape as Record<string, ZodTypeAny> | undefined;
  if (!shape || typeof shape !== 'object') return {};

  const partial: Record<string, any> = {};
  for (const [key, sectionSchema] of Object.entries(shape)) {
    if (!(key in parsed)) continue;
    const result = sectionSchema.safeParse(parsed[key]);
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
}): { validated: Partial<SettingsData>; raw: any; hadErrors: boolean } {
  try {
    const settingsFile = path.join(opts.settingsDir, 'settings.json');

    if (!fs.existsSync(settingsFile)) {
      return { validated: {}, raw: {}, hadErrors: false };
    }

    const content = fs.readFileSync(settingsFile, 'utf-8');
    const parsed = JSON.parse(content);

    // Validate and parse with Zod
    const validated = opts.schema.safeParse(parsed);

    if (!validated.success) {
      if (!opts.disableLogging) {
        opts.loggingService?.warn('Settings file contains invalid values', {
          errors: validated.error.issues.map((issue: any) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      // Preserve valid top-level sections; invalid sections fall back to defaults
      // via mergeSettings. The file is left unchanged for the user to fix.
      return { validated: parsePartialSections(parsed, opts.schema), raw: parsed, hadErrors: true };
    }

    return { validated: validated.data as Partial<SettingsData>, raw: parsed, hadErrors: false };
  } catch (error: any) {
    if (!opts.disableLogging) {
      opts.loggingService?.error('Failed to load settings file', {
        error: error instanceof Error ? error.message : String(error),
        settingsFile: path.join(opts.settingsDir, 'settings.json'),
      });
    }

    return { validated: {}, raw: {}, hadErrors: false };
  }
}

export function saveSettingsToFile(opts: {
  settingsDir: string;
  settings: SettingsData;
  stripSensitiveSettings: (settings: SettingsData) => Partial<SettingsData>;
  disableLogging?: boolean;
  loggingService?: LoggerLike;
}): void {
  try {
    const settingsFile = path.join(opts.settingsDir, 'settings.json');

    // Ensure directory exists
    if (!fs.existsSync(opts.settingsDir)) {
      fs.mkdirSync(opts.settingsDir, { recursive: true });
    }

    // Filter out sensitive settings before saving to disk
    const settingsToSave = opts.stripSensitiveSettings(opts.settings);
    const newContent = JSON.stringify(settingsToSave, null, 2);

    // Only write if file doesn't exist or content has changed
    // Compare parsed objects rather than string content to avoid false positives
    // from formatting differences
    if (fs.existsSync(settingsFile)) {
      try {
        const existingContent = fs.readFileSync(settingsFile, 'utf-8');
        const existingParsed = JSON.parse(existingContent);

        // Deep equality check that ignores formatting and key order
        if (deepEqual(existingParsed, settingsToSave)) {
          return; // No changes, don't write
        }
      } catch {
        // If we can't parse the existing file, write the new content anyway
        // This handles corrupted files gracefully
      }
    }

    fs.writeFileSync(settingsFile, newContent, 'utf-8');
  } catch (error: any) {
    if (!opts.disableLogging) {
      opts.loggingService?.error('Failed to save settings file', {
        error: error instanceof Error ? error.message : String(error),
        settingsFile: path.join(opts.settingsDir, 'settings.json'),
      });
    }
  }
}

/**
 * Remove sensitive settings that should never be persisted to disk.
 */
export function stripSensitiveSettings(settings: SettingsData): Partial<SettingsData> {
  const cleaned = JSON.parse(JSON.stringify(settings));

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
    // mentorMode and planMode are persisted so they survive across sessions
  }

  return cleaned;
}

/**
 * Check if target object is missing any keys that exist in source.
 */
export function hasMissingKeys(
  target: any,
  source: any,
  optionalDefaultKeys: Set<string>,
  prefix: string = '',
): boolean {
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;

    const pathKey = prefix ? `${prefix}.${key}` : key;

    const sourceValue = source[key];

    if (!(key in target)) {
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
    const targetValue = target[key];

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
