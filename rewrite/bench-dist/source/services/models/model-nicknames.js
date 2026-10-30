import { parseFavoriteEntry, serializeFavorite, FAVORITES_TAB_ID } from './model-favorites.js';
import { stripReasoningEffortSuffix } from './reasoning-effort.js';
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
const NICKNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
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
export function parseNicknameTargetEntry(raw) {
    const { value, reasoningEffort } = stripReasoningEffortSuffix(raw);
    const parsed = parseFavoriteEntry(value);
    if (!parsed)
        return null;
    return reasoningEffort ? { ...parsed, reasoningEffort } : parsed;
}
/** Serializes a target back to its persisted "provider/modelId[:effort]" form. */
export function serializeNicknameTarget(target) {
    const base = serializeFavorite(target.provider, target.modelId);
    return target.reasoningEffort ? base + ':' + target.reasoningEffort : base;
}
/**
 * Reads and parses `agent.modelNicknames`, silently dropping malformed
 * entries and keeping only the first of case-insensitive duplicate names (a
 * JSON object cannot hold duplicate keys, but a case-duplicate pair can be
 * hand-edited in; dropping keeps every lookup unambiguous).
 */
export function getNicknameEntries(settingsService) {
    const raw = settingsService.get('agent.modelNicknames');
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw))
        return [];
    const entries = [];
    const seenLower = new Set();
    for (const [nickname, target] of Object.entries(raw)) {
        if (typeof target !== 'string')
            continue;
        if (!NICKNAME_PATTERN.test(nickname))
            continue;
        const lower = nickname.toLowerCase();
        if (seenLower.has(lower))
            continue;
        const parsed = parseNicknameTargetEntry(target);
        if (!parsed)
            continue;
        seenLower.add(lower);
        entries.push({ nickname, ...parsed });
    }
    return entries;
}
/**
 * Nickname labels keyed by serialized model identity (`provider/modelId`),
 * for rendering existing nicknames on picker rows.
 */
export function getNicknameLabels(settingsService) {
    const labels = new Map();
    for (const entry of getNicknameEntries(settingsService)) {
        labels.set(serializeFavorite(entry.provider, entry.modelId), entry.nickname);
    }
    return labels;
}
/**
 * Nickname targets as model rows (id + home provider only), one per model,
 * in settings order. Two names for the same model collapse to the first.
 * Reads settings only: no catalog fetch. The Nicknames tab uses these rows
 * the same way the Favorites tab uses `getFavoriteModelInfos`.
 */
export function getNicknameModelInfos(settingsService) {
    const seen = new Set();
    const models = [];
    for (const entry of getNicknameEntries(settingsService)) {
        const key = serializeFavorite(entry.provider, entry.modelId);
        if (seen.has(key))
            continue;
        seen.add(key);
        models.push({ id: entry.modelId, provider: entry.provider });
    }
    return models;
}
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
export function validateNicknameName(rawNickname, options = {}) {
    const nickname = rawNickname.trim();
    if (!nickname)
        return { ok: false, error: 'Nickname cannot be empty.' };
    if (nickname.length > NICKNAME_MAX_LENGTH) {
        return { ok: false, error: 'Nickname must be at most ' + NICKNAME_MAX_LENGTH + ' characters.' };
    }
    if (!NICKNAME_PATTERN.test(nickname)) {
        return {
            ok: false,
            error: 'Nicknames may only contain letters, numbers, hyphens, and underscores, and must start with a letter or number.',
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
/**
 * Validates and persists one nickname -> target mapping. Rejected input
 * returns the reason and writes nothing, so an editor can keep the user in
 * place. Renaming (the target already mapped under another name) removes the
 * old key. A name already used by a different model is not moved unless
 * `replace` is set — the first attempt returns that model as `conflict` so
 * the editor can ask. Committing an unchanged mapping writes nothing.
 */
export function setNicknameTarget(settingsService, rawNickname, target, options = {}) {
    const entries = getNicknameEntries(settingsService);
    const existingForTarget = entries.find((entry) => entry.provider.toLowerCase() === target.provider.toLowerCase() && entry.modelId === target.modelId);
    const lower = rawNickname.trim().toLowerCase();
    const taken = entries.find((entry) => entry !== existingForTarget && entry.nickname.toLowerCase() === lower);
    const validation = validateNicknameName(rawNickname, {
        providerIds: options.providerIds,
        // The colliding name is reported below as a replacement offer instead of a
        // plain uniqueness error. Every other live name still conflicts.
        existingNicknames: entries
            .filter((entry) => entry !== existingForTarget && entry !== taken)
            .map((entry) => entry.nickname),
    });
    if (!validation.ok)
        return validation;
    if (taken && !options.replace) {
        return {
            ok: false,
            error: 'Nickname "' +
                taken.nickname +
                '" already names ' +
                taken.provider +
                '/' +
                taken.modelId +
                '. Press Enter to use it here instead.',
            conflict: { nickname: taken.nickname, provider: taken.provider, modelId: taken.modelId },
        };
    }
    const nickname = validation.nickname;
    const serialized = serializeNicknameTarget(target);
    if (existingForTarget &&
        existingForTarget.nickname === nickname &&
        serializeNicknameTarget(existingForTarget) === serialized) {
        return { ok: true };
    }
    const next = {};
    for (const entry of entries) {
        if (existingForTarget && entry.nickname === existingForTarget.nickname)
            continue;
        if (entry.nickname.toLowerCase() === lower)
            continue;
        next[entry.nickname] = serializeNicknameTarget(entry);
    }
    next[nickname] = serialized;
    settingsService.setPersistent('agent.modelNicknames', next);
    return { ok: true };
}
/** Removes all nickname aliases attached to one model. */
export function removeNicknameTarget(settingsService, target) {
    const entries = getNicknameEntries(settingsService);
    const remaining = entries.filter((entry) => entry.provider.toLowerCase() !== target.provider.toLowerCase() || entry.modelId !== target.modelId);
    if (remaining.length === entries.length)
        return false;
    const next = {};
    for (const entry of remaining)
        next[entry.nickname] = serializeNicknameTarget(entry);
    settingsService.setPersistent('agent.modelNicknames', next);
    return true;
}
/**
 * Applies one Enter in the nickname editor. A pending replacement commits
 * only while the text still matches that name; otherwise this is an ordinary
 * save, and a collision comes back as a new pending replacement.
 */
export function commitNicknameEdit(settingsService, draft, providerIds) {
    const replace = draft.pendingReplace != null && draft.pendingReplace.nickname.toLowerCase() === draft.text.trim().toLowerCase();
    const result = setNicknameTarget(settingsService, draft.text, { provider: draft.provider, modelId: draft.modelId }, { providerIds, replace });
    if (result.ok)
        return { saved: true };
    return { saved: false, error: result.error, pendingReplace: result.conflict ?? null };
}
/**
 * Exact, case-insensitive nickname lookup for the --model fast path.
 * `providerScope` (an explicit --provider or a provider prefix parsed from
 * the flag) narrows eligibility to targets on that provider: the user named a
 * provider, so a nickname homed elsewhere must not hijack the flag.
 * `knownProviders` excludes hand-edited nicknames equal to a registered
 * provider id, which creation-time validation would have rejected.
 */
export function findNicknameMatch(settingsService, pattern, options) {
    const trimmed = pattern.trim();
    if (!trimmed)
        return undefined;
    const patternLower = trimmed.toLowerCase();
    const scope = options?.providerScope?.toLowerCase();
    const providerNamed = new Set((options?.knownProviders ?? []).map((providerId) => providerId.toLowerCase()));
    return getNicknameEntries(settingsService).find((entry) => entry.nickname.toLowerCase() === patternLower &&
        (!scope || entry.provider.toLowerCase() === scope) &&
        !providerNamed.has(entry.nickname.toLowerCase()));
}
//# sourceMappingURL=model-nicknames.js.map