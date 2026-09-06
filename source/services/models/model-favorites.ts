import type { ISettingsService } from '../service-interfaces.js';
import type { ModelInfo } from '../model-service.js';

/**
 * Sentinel "provider id" for the pseudo-provider tab that shows favorited
 * models in the picker. Deliberately not a valid provider id shape: real
 * provider ids must match `PROVIDER_NAME_REGEX`
 * (`/^[a-zA-Z0-9][-a-zA-Z0-9_.]*$/` in source/providers/provider-service.ts),
 * which requires the FIRST character to be a letter or digit — a leading
 * underscore is never legal — so this sentinel can never collide with a real
 * or custom provider id.
 */
export const FAVORITES_TAB_ID = '__favorites__';

const FAVORITE_SEPARATOR = '/';

/**
 * Serializes a favorite as `${provider}/${modelId}`.
 *
 * Splitting on the FIRST '/' is the only unambiguous scheme: provider ids are
 * validated at creation time by `PROVIDER_NAME_REGEX`
 * (source/providers/provider-service.ts), which allows only letters, numbers,
 * hyphens, underscores, and dots — never '/'. A model id, by contrast, CAN
 * contain '/' (e.g. OpenRouter's `anthropic/claude-3.5-sonnet`). So "provider
 * id, then everything after the first separator" round-trips every real
 * model id, including ones that are themselves slash-delimited; splitting on
 * the LAST '/' would not (it would cut `anthropic/claude-3.5-sonnet` into
 * provider `openrouter/anthropic` and id `claude-3.5-sonnet`).
 */
export function serializeFavorite(provider: string, modelId: string): string {
  return `${provider}${FAVORITE_SEPARATOR}${modelId}`;
}

export type ParsedFavorite = { provider: string; modelId: string };

/**
 * Parses one persisted favorite entry. Returns null for malformed entries
 * (no separator, empty provider, or empty model id) rather than throwing, so
 * a corrupted or hand-edited settings file degrades to "fewer favorites"
 * instead of crashing resolution or the picker.
 */
export function parseFavoriteEntry(entry: string): ParsedFavorite | null {
  const idx = entry.indexOf(FAVORITE_SEPARATOR);
  if (idx <= 0 || idx === entry.length - 1) return null;
  return { provider: entry.slice(0, idx), modelId: entry.slice(idx + 1) };
}

/** Reads and parses `agent.favoriteModels`, silently dropping malformed entries. */
export function getFavoriteEntries(settingsService: ISettingsService): ParsedFavorite[] {
  const raw = settingsService.get('agent.favoriteModels');
  const list = Array.isArray(raw) ? raw : [];
  const parsed: ParsedFavorite[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const p = parseFavoriteEntry(entry);
    if (p) parsed.push(p);
  }
  return parsed;
}

/**
 * Favorites as `ModelInfo` rows (id + home provider only — no name, no
 * catalog fields), in persisted order. Reads settings only: no catalog
 * fetch, no credential check, no network. Used both by the picker's
 * Favorites tab and by `resolveModelFlag`'s pre-catalog fast path.
 */
export function getFavoriteModelInfos(settingsService: ISettingsService): ModelInfo[] {
  return getFavoriteEntries(settingsService).map(({ provider, modelId }) => ({ id: modelId, provider }));
}

export function isFavoriteModel(settingsService: ISettingsService, provider: string, modelId: string): boolean {
  return getFavoriteEntries(settingsService).some(
    (f) => f.provider.toLowerCase() === provider.toLowerCase() && f.modelId === modelId,
  );
}

/**
 * Toggles a model's favorite status and persists immediately. Returns
 * whether the model is favorited after the toggle. No naming/confirmation
 * step: this is deliberately a single, immediate, idempotent-in-intent
 * action (see `terminal-input-ownership` skill on why no second input mode
 * is introduced here).
 */
export function toggleFavoriteModel(settingsService: ISettingsService, provider: string, modelId: string): boolean {
  const raw = settingsService.get('agent.favoriteModels');
  const list = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];

  const existingIndex = list.findIndex((entry) => {
    const parsed = parseFavoriteEntry(entry);
    return parsed !== null && parsed.provider.toLowerCase() === provider.toLowerCase() && parsed.modelId === modelId;
  });

  let next: string[];
  let nowFavorited: boolean;
  if (existingIndex >= 0) {
    next = list.filter((_, i) => i !== existingIndex);
    nowFavorited = false;
  } else {
    next = [...list, serializeFavorite(provider, modelId)];
    nowFavorited = true;
  }

  settingsService.setPersistent('agent.favoriteModels', next);
  return nowFavorited;
}
