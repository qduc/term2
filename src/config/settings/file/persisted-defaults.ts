/**
 * Which defaults `settings.json` may leave out. Everything else in the file is a
 * full dump of the merged settings (Contract 10, decision 5).
 */
import { DEFAULT_SETTINGS, type SettingsData } from '../settings-schema.js';

/**
 * Defaults computed from the machine that runs Term2 (an absolute path under its data
 * directory). settings.json holds one only when a write sets it, it differs from this
 * machine's default, or the file already held it: a dumped copy would point another
 * machine, or another XDG_DATA_HOME, at this machine's path.
 */
const COMPUTED_PATH_DEFAULT_KEYS = new Set<string>(['memory.directory']);
// The schema's internal model fallback is not a user's model choice.
const OMIT_WHEN_IMPLICIT = new Set([...COMPUTED_PATH_DEFAULT_KEYS, 'agent.modelSelection']);

// Some settings with default values are optional to persist, so their absence
// does not trigger a startup rewrite. Absence of agent.maxOutputTokens preserves
// inherited output-allocation provenance on disk; a computed path default is
// left out so the file stays portable.
export const OPTIONAL_DEFAULT_KEYS = new Set<string>(['agent.maxOutputTokens', ...OMIT_WHEN_IMPLICIT]);

/** Which keys a write names: an explicit set always writes a computed path default; a reset forgets it. */
export type ComputedDefaultIntent = { set?: readonly string[]; reset?: readonly string[] | 'all' };

function hasSettingPath(target: unknown, key: string): boolean {
  let current: unknown = target;
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

function readSettingPath(target: unknown, key: string): unknown {
  let current: unknown = target;
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Leave an implicit default (an installation-local path or an unchosen model) out of the bytes written. It is
 * written when this write sets it explicitly, when its value differs from this machine's
 * default, or when the file on disk already holds it and this write is not a reset of it.
 * An existing value equal to the default is kept: it cannot be told apart from a value the
 * user chose, and dropping it would move memory if XDG_DATA_HOME later changed.
 */
export function omitImplicitDefaults(
  cleaned: Partial<SettingsData>,
  raw: unknown,
  intent: ComputedDefaultIntent,
): void {
  for (const key of OMIT_WHEN_IMPLICIT) {
    if (intent.set?.includes(key)) continue;
    if (!hasSettingPath(cleaned, key)) continue;
    if (JSON.stringify(readSettingPath(cleaned, key)) !== JSON.stringify(readSettingPath(DEFAULT_SETTINGS, key))) {
      continue;
    }
    const resetHere =
      intent.reset === 'all' || (intent.reset ?? []).some((reset) => reset === key || key.startsWith(`${reset}.`));
    if (!resetHere && hasSettingPath(raw, key)) continue;
    const parts = key.split('.');
    const parent = readSettingPath(cleaned, parts.slice(0, -1).join('.')) as Record<string, unknown>;
    delete parent[parts[parts.length - 1]!];
  }
}
