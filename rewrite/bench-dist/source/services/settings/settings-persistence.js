import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import deepEqual from 'fast-deep-equal';
import { mergeSettings } from './settings-merger.js';
import { unwrapSchema } from './setting-schema-utils.js';
import { migratePersistedSelections } from './persisted-selection-migration.js';
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
/**
 * Bounded scan fallback for a settings file whose bytes are not valid JSON:
 * salvage the longest complete JSON object embedded in the corrupt content by
 * trying every object/array start and every matching close candidate. Leading
 * or trailing garbage (for example a prepended log line or an appended crash
 * fragment) is skipped. The iteration cap keeps a pathological all-brackets
 * file from stalling startup; when the cap is hit the file is treated as
 * unrecoverable (the original bytes are preserved untouched).
 */
export function scanForRecoverableJson(content) {
    const MAX_SCAN_ITERATIONS = 20_000;
    let iterations = 0;
    for (let start = 0; start < content.length; start++) {
        const open = content[start];
        if (open !== '{' && open !== '[')
            continue;
        const close = open === '{' ? '}' : ']';
        for (let end = content.length - 1; end > start; end--) {
            if (++iterations > MAX_SCAN_ITERATIONS)
                return null;
            if (content[end] !== close)
                continue;
            const candidate = content.slice(start, end + 1);
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return {
                        recovered: parsed,
                        reason: `recovered a JSON object at byte offset ${start} inside corrupt content`,
                    };
                }
            }
            catch {
                // Try the next candidate end; the longer candidate did not parse.
            }
        }
    }
    return null;
}
function waitForLockRetry(retryMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, retryMs);
}
export function acquireSettingsLock(settingsDir, options = {}) {
    const lockFile = path.join(settingsDir, 'settings.json.lock');
    const retryMs = options.retryMs ?? LOCK_RETRY_MS;
    const staleMs = options.staleMs ?? STALE_LOCK_MS;
    const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
    while (true) {
        try {
            const fd = fs.openSync(lockFile, 'wx');
            const token = randomUUID();
            try {
                fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), 'utf-8');
            }
            finally {
                fs.closeSync(fd);
            }
            return () => {
                try {
                    const content = fs.readFileSync(lockFile, 'utf-8');
                    const current = JSON.parse(content);
                    if (!current || typeof current !== 'object' || current.token !== token) {
                        return;
                    }
                    fs.unlinkSync(lockFile);
                }
                catch (error) {
                    const code = error.code;
                    if (code !== 'ENOENT' && !(error instanceof SyntaxError)) {
                        throw error;
                    }
                }
            };
        }
        catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            try {
                if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
                    fs.unlinkSync(lockFile);
                    continue;
                }
            }
            catch (lockError) {
                if (lockError.code === 'ENOENT') {
                    continue;
                }
                throw lockError;
            }
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for settings lock at ${lockFile}`);
            }
            waitForLockRetry(retryMs);
        }
    }
}
/**
 * Try to parse each top-level section of the settings object independently.
 * Valid sections are included in the result; invalid sections are omitted so
 * they fall back to defaults in mergeSettings. The file on disk is never touched.
 */
function parsePartialSections(parsed, schema) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return {};
    const record = parsed;
    const objectSchema = unwrapSchema(schema);
    if (!objectSchema?.shape || typeof objectSchema.shape !== 'object')
        return {};
    const shape = objectSchema.shape;
    const partial = {};
    for (const [key, sectionSchema] of Object.entries(shape)) {
        if (!Object.prototype.hasOwnProperty.call(record, key))
            continue;
        const result = sectionSchema.safeParse(record[key]);
        if (result.success) {
            partial[key] = result.data;
        }
    }
    return partial;
}
export function loadSettingsFromFile(opts) {
    try {
        const settingsFile = path.join(opts.settingsDir, 'settings.json');
        if (!fs.existsSync(settingsFile)) {
            return { validated: {}, raw: {}, hadErrors: false };
        }
        const content = fs.readFileSync(settingsFile, 'utf-8');
        let parsed;
        let recovery;
        let errorDetails = [];
        try {
            parsed = JSON.parse(content);
        }
        catch (error) {
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
                recoveredSectionKeys: Object.keys(scanned.recovered),
            };
            if (!opts.disableLogging) {
                opts.loggingService?.warn('Recovered settings content from a corrupt file', {
                    settingsFile,
                    reason: recovery.reason,
                    recoveredSectionKeys: recovery.recoveredSectionKeys,
                });
            }
        }
        // Both startup and locked save reloads pass this file-only boundary.
        // Keep raw bytes/values available for migration detection and diagnosis.
        let migration;
        try {
            migration = migratePersistedSelections(parsed);
        }
        catch (error) {
            return {
                validated: parsePartialSections(parsed, opts.schema),
                raw: parsed,
                hadErrors: true,
                errorDetails: [...errorDetails, error instanceof Error ? error.message : String(error)],
                recovery,
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
            };
        }
        return {
            validated: validated.data,
            raw: parsed,
            // A recovered file still had errors: the caller must not treat a salvage
            // as a clean load (for example by overwriting the corrupt file in place).
            hadErrors: recovery !== undefined,
            errorDetails: recovery ? errorDetails : undefined,
            recovery,
            migratedSelections: migration.migrated,
        };
    }
    catch (error) {
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
/**
 * Move a corrupt `settings.json` aside so its original bytes remain available
 * for diagnosis, leaving the settings directory ready for a fresh atomic
 * replacement. Returns the quarantine path, or undefined when the file could
 * not be moved (the corrupt file then stays in place and later writes refuse
 * to overwrite it).
 */
export function quarantineCorruptSettingsFile(settingsDir) {
    const settingsFile = path.join(settingsDir, 'settings.json');
    const quarantinePath = path.join(settingsDir, `settings.json.corrupt-${Date.now()}`);
    try {
        fs.renameSync(settingsFile, quarantinePath);
        return quarantinePath;
    }
    catch {
        return undefined;
    }
}
export function saveSettingsToFile(opts) {
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
                throw new Error(`Refusing to overwrite invalid settings file: ${loaded.errorDetails?.join('; ') ?? 'unknown error'}`);
            }
            const current = mergeSettings(opts.defaults, loaded.validated, {}, {}, {
                disableLogging: opts.disableLogging,
                loggingService: opts.loggingService,
            });
            const next = opts.mutate(structuredClone(current));
            const validation = opts.schema.safeParse(next);
            if (!validation.success) {
                throw new Error(`Refusing to save invalid settings: ${validation.error.issues
                    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                    .join('; ')}`);
            }
            const settingsToSave = opts.stripSensitiveSettings(next, loaded.raw);
            const newContent = JSON.stringify(settingsToSave, null, 2);
            // Only write if file doesn't exist or content has changed. Compare parsed
            // objects rather than text so formatting never causes a rewrite.
            if (fs.existsSync(settingsFile)) {
                try {
                    const existingContent = fs.readFileSync(settingsFile, 'utf-8');
                    const existingParsed = JSON.parse(existingContent);
                    if (deepEqual(existingParsed, settingsToSave)) {
                        return next;
                    }
                }
                catch {
                    // The load above would have rejected an invalid existing file. This
                    // is only a last-moment external replacement; writing a new atomic
                    // snapshot is still safer than a direct truncating write.
                }
            }
            const tempFile = path.join(opts.settingsDir, `settings.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
            let tempFileCreated = false;
            try {
                const tempFd = fs.openSync(tempFile, 'wx');
                tempFileCreated = true;
                try {
                    fs.writeFileSync(tempFd, newContent, 'utf-8');
                    fs.fsyncSync(tempFd);
                }
                finally {
                    fs.closeSync(tempFd);
                }
                fs.renameSync(tempFile, settingsFile);
                tempFileCreated = false;
            }
            finally {
                if (tempFileCreated) {
                    try {
                        fs.unlinkSync(tempFile);
                    }
                    catch {
                        // Best effort only: preserve the original write/rename failure.
                    }
                }
            }
            return next;
        }
        finally {
            releaseLock();
        }
    }
    catch (error) {
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
export function stripSensitiveSettings(settings) {
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
        // The canonical activeProfileId is persisted so it survives across sessions.
    }
    return cleaned;
}
/**
 * Check if target object is missing any keys that exist in source.
 */
export function hasMissingKeys(target, source, optionalDefaultKeys, prefix = '') {
    if (!source || typeof source !== 'object' || Array.isArray(source))
        return false;
    if (!target || typeof target !== 'object' || Array.isArray(target))
        return true;
    const sourceObj = source;
    const targetObj = target;
    for (const key in sourceObj) {
        if (!Object.prototype.hasOwnProperty.call(sourceObj, key))
            continue;
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
        if (sourceValue &&
            typeof sourceValue === 'object' &&
            !Array.isArray(sourceValue) &&
            targetValue &&
            typeof targetValue === 'object' &&
            !Array.isArray(targetValue)) {
            if (hasMissingKeys(targetValue, sourceValue, optionalDefaultKeys, pathKey)) {
                return true;
            }
        }
    }
    return false;
}
//# sourceMappingURL=settings-persistence.js.map