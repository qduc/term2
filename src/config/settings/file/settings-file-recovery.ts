/**
 * Corrupt-file recovery for `settings.json`: a bounded scan that salvages a JSON
 * object from corrupt bytes, and the quarantine that moves the original bytes aside
 * before a fresh replacement is written. Whether to quarantine is the caller's
 * decision (`SettingsService`); nothing here writes a settings file.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Evidence that a syntactically corrupt settings file was salvaged by
 * {@link scanForRecoverableJson} before schema validation ran. The file itself
 * is unchanged here: `hadErrors` stays true and the original bytes remain on
 * disk until the SettingsService boundary decides to quarantine them.
 */
export type SettingsFileRecovery = {
  recovered: true;
  reason: string;
  recoveredSectionKeys: string[];
};

/**
 * Bounded scan fallback for a settings file whose bytes are not valid JSON:
 * salvage the longest complete JSON object embedded in the corrupt content by
 * trying every object/array start and every matching close candidate. Leading
 * or trailing garbage (for example a prepended log line or an appended crash
 * fragment) is skipped. The iteration cap keeps a pathological all-brackets
 * file from stalling startup; when the cap is hit the file is treated as
 * unrecoverable (the original bytes are preserved untouched).
 */
export function scanForRecoverableJson(content: string): { recovered: unknown; reason: string } | null {
  const MAX_SCAN_ITERATIONS = 20_000;
  let iterations = 0;

  for (let start = 0; start < content.length; start++) {
    const open = content[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';

    for (let end = content.length - 1; end > start; end--) {
      if (++iterations > MAX_SCAN_ITERATIONS) return null;
      if (content[end] !== close) continue;
      const candidate = content.slice(start, end + 1);
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return {
            recovered: parsed,
            reason: `recovered a JSON object at byte offset ${start} inside corrupt content`,
          };
        }
      } catch {
        // Try the next candidate end; the longer candidate did not parse.
      }
    }
  }

  return null;
}

/**
 * Move a corrupt `settings.json` aside so its original bytes remain available
 * for diagnosis, leaving the settings directory ready for a fresh atomic
 * replacement. Returns the quarantine path, or undefined when the file could
 * not be moved (the corrupt file then stays in place and later writes refuse
 * to overwrite it).
 */
export function quarantineCorruptSettingsFile(settingsDir: string): string | undefined {
  const settingsFile = path.join(settingsDir, 'settings.json');
  const quarantinePath = path.join(settingsDir, `settings.json.corrupt-${Date.now()}`);
  try {
    fs.renameSync(settingsFile, quarantinePath);
    return quarantinePath;
  } catch {
    return undefined;
  }
}
