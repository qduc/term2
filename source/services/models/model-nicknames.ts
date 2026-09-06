import type { ISettingsService } from '../service-interfaces.js';
import { parseFavoriteEntry, serializeFavorite, FAVORITES_TAB_ID } from './model-favorites.js';
import { stripReasoningEffortSuffix, type ModelSettingsReasoningEffort } from './reasoning-effort.js';

/**
 * A nickname target: the model a nickname points at, plus an optional
 * reasoning effort applied whenever the nickname is used and the CLI flag
 * carries no inline ":<effort>" suffix (an inline suffix always wins).
 */
export type ParsedNicknameTarget = {
  provider: string;
  modelId: string;
  reasoningEffort?: ModelSettingsReasoningEffort;
};

export type NicknameEntry = { nickname: string } & ParsedNicknameTarget;

/**
 * Nicknames are typed as CLI values (`-m <nickname>`) and rendered inline in
 * the picker, so they are restricted to an identifier shape: letters, digits,
 * hyphens, and underscores, starting with a letter or digit.
 *
 * Deliberately excluded, each for a concrete reason:
 * - '/' — a slash in a --model flag parses as a provider prefix, and the
 *   stored target already uses first-slash splitting (see model-favorites.ts);
 * - ':' — a trailing ":<effort>" parses as a reasoning-effort suffix;
 * - whitespace, quotes, and shell metacharacters — the value is typed as a
 *   CLI argument and must stay shell-safe;
 * - a leading '-' — meow would parse `-m -op` as an unknown flag;
 * - '.' — keeps a nickname visibly distinct from dotted model ids, the shape
 *   it must never be confused with.
 */
export const NICKNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Generous ceiling; nicknames exist to be shorter than the ids they replace. */
export const NICKNAME_MAX_LENGTH = 64;

/**
 * Parses one persisted target entry ("provider/modelId" with an optional
 * trailing ":<effort>"). Splitting on the FIRST '/' reuses model-favorites'
 * helper because it solved this exact serialization problem: provider ids can
 * never contain '/', but a model id can (e.g. OpenRouter's
 * `anthropic/claude-3.5-sonnet`). Returns null for malformed entries so a
 * hand-edited settings file degrades to "fewer nicknames" instead of crashing
 * resolution or the picker.
 */
export function parseNicknameTargetEntry(raw: string): ParsedNicknameTarget | null {
  const { value, reasoningEffort } = stripReasoningEffortSuffix(raw);
  const parsed = parseFavoriteEntry(value);
  if (!parsed) return null;
  return reasoningEffort ? { ...parsed, reasoningEffort } : parsed;
}

/** Serializes a target back to its persisted "provider/modelId[:effort]" form. */
export function serializeNicknameTarget(target: ParsedNicknameTarget): string {
  const base = serializeFavorite(target.provider, target.modelId);
  return target.reasoningEffort ? base + ':' + target.reasoningEffort : base;
}

/**
 * Reads and parses `agent.modelNicknames`, silently dropping malformed
 * entries and keeping only the first of case-insensitive duplicate names (a
 * JSON object cannot hold duplicate keys, but a case-duplicate pair can be
 * hand-edited in; dropping keeps every lookup unambiguous).
 */
export function getNicknameEntries(settingsService: ISettingsService): NicknameEntry[] {
  const raw: unknown = settingsService.get('agent.modelNicknames');
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const entries: NicknameEntry[] = [];
  const seenLower = new Set<string>();
  for (const [nickname, target] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof target !== 'string') continue;
    if (!NICKNAME_PATTERN.test(nickname)) continue;
    const lower = nickname.toLowerCase();
    if (seenLower.has(lower)) continue;
    const parsed = parseNicknameTargetEntry(target);
    if (!parsed) continue;
    seenLower.add(lower);
    entries.push({ nickname, ...parsed });
  }
  return entries;
}

/**
 * Nickname labels keyed by serialized model identity (`provider/modelId`),
 * for rendering existing nicknames on picker rows.
 */
export function getNicknameLabels(settingsService: ISettingsService): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of getNicknameEntries(settingsService)) {
    labels.set(serializeFavorite(entry.provider, entry.modelId), entry.nickname);
  }
  return labels;
}

export type NicknameValidation = { ok: true; nickname: string } | { ok: false; error: string };

/**
 * Validates a nickname name against the ambiguity rules:
 * - identifier shape (see NICKNAME_PATTERN) and bounded length;
 * - never the reserved Favorites pseudo-provider sentinel;
 * - never equal to a registered provider id (checked case-insensitively) —
 *   `-m <provider>` means "match that provider", and a nickname must not
 *   shadow that reading;
 * - unique among the other nicknames (case-insensitively) — two names that
 *   differ only by case would make lookup order-dependent.
 *
 * Callers that are renaming pass `existingNicknames` already minus the name
 * being replaced. Collisions with real model ids are NOT rejected here
 * (detecting them needs a catalog, unavailable offline); precedence at
 * resolution time — exact nickname wins, the real id stays reachable as
 * `provider/id` — covers that case instead.
 */
export function validateNicknameName(
  rawNickname: string,
  options: { providerIds?: readonly string[]; existingNicknames?: readonly string[] } = {},
): NicknameValidation {
  const nickname = rawNickname.trim();
  if (!nickname) return { ok: false, error: 'Nickname cannot be empty.' };
  if (nickname.length > NICKNAME_MAX_LENGTH) {
    return { ok: false, error: 'Nickname must be at most ' + NICKNAME_MAX_LENGTH + ' characters.' };
  }
  if (!NICKNAME_PATTERN.test(nickname)) {
    return {
      ok: false,
      error:
        'Nicknames may only contain letters, numbers, hyphens, and underscores, and must start with a letter or number.',
    };
  }
  if (nickname.toLowerCase() === FAVORITES_TAB_ID.toLowerCase()) {
    return { ok: false, error: '"' + nickname + '" is a reserved name.' };
  }
  const lower = nickname.toLowerCase();
  if (options.providerIds?.some((providerId) => providerId.toLowerCase() === lower)) {
    return { ok: false, error: '"' + nickname + '" is already a provider name.' };
  }
  if (options.existingNicknames?.some((existing) => existing.toLowerCase() === lower)) {
    return { ok: false, error: 'Nickname "' + nickname + '" is already in use.' };
  }
  return { ok: true, nickname };
}

export type SetNicknameResult = { ok: true } | { ok: false; error: string };

/**
 * Validates and persists one nickname -> target mapping. Rejected input
 * returns the reason and writes nothing, so an editor can keep the user in
 * place. Renaming (the target already mapped under another name) removes the
 * old key; re-pointing a name at a new target just overwrites it. Committing
 * an unchanged mapping writes nothing.
 */
export function setNicknameTarget(
  settingsService: ISettingsService,
  rawNickname: string,
  target: ParsedNicknameTarget,
  options: { providerIds?: readonly string[] } = {},
): SetNicknameResult {
  const entries = getNicknameEntries(settingsService);
  const existingForTarget = entries.find(
    (entry) => entry.provider.toLowerCase() === target.provider.toLowerCase() && entry.modelId === target.modelId,
  );
  const lower = rawNickname.trim().toLowerCase();
  const validation = validateNicknameName(rawNickname, {
    providerIds: options.providerIds,
    // Only the entry being renamed away is exempt; every other live name —
    // including a case-different variant — is a conflict. Re-pointing a name
    // at a different model is deliberately NOT an operation here: silently
    // stealing another model's nickname is never what a typo-ing user wants,
    // and a lookup keyed case-insensitively could not tell them apart anyway.
    existingNicknames: entries.filter((entry) => entry !== existingForTarget).map((entry) => entry.nickname),
  });
  if (!validation.ok) return validation;
  const nickname = validation.nickname;
  const serialized = serializeNicknameTarget(target);

  if (
    existingForTarget &&
    existingForTarget.nickname === nickname &&
    serializeNicknameTarget(existingForTarget) === serialized
  ) {
    return { ok: true };
  }

  const next: Record<string, string> = {};
  for (const entry of entries) {
    if (existingForTarget && entry.nickname === existingForTarget.nickname) continue;
    if (entry.nickname.toLowerCase() === lower) continue;
    next[entry.nickname] = serializeNicknameTarget(entry);
  }
  next[nickname] = serialized;
  settingsService.setPersistent('agent.modelNicknames', next);
  return { ok: true };
}

/**
 * Exact, case-insensitive nickname lookup for the --model fast path.
 * `providerScope` (an explicit --provider or a provider prefix parsed from
 * the flag) narrows eligibility to targets on that provider: the user named a
 * provider, so a nickname homed elsewhere must not hijack the flag.
 * `knownProviders` excludes hand-edited nicknames equal to a registered
 * provider id, which creation-time validation would have rejected.
 */
export function findNicknameMatch(
  settingsService: ISettingsService,
  pattern: string,
  options?: { providerScope?: string; knownProviders?: readonly string[] },
): NicknameEntry | undefined {
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;
  const patternLower = trimmed.toLowerCase();
  const scope = options?.providerScope?.toLowerCase();
  const providerNamed = new Set((options?.knownProviders ?? []).map((providerId) => providerId.toLowerCase()));
  return getNicknameEntries(settingsService).find(
    (entry) =>
      entry.nickname.toLowerCase() === patternLower &&
      (!scope || entry.provider.toLowerCase() === scope) &&
      !providerNamed.has(entry.nickname.toLowerCase()),
  );
}
