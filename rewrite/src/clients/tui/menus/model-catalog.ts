/**
 * The legacy model services the model and subagent-pool menus call, under their
 * legacy names. Data access goes through the session's TuiModelSettings, which
 * the app serves from the same legacy modules; the pure pieces are copied:
 * serializeFavorite/FAVORITES_TAB_ID (model-favorites.ts), model-tabs.ts,
 * parseModelProviderArg (model-provider-arg.ts), isSubsequenceMatch
 * (subsequence-filter.ts) and unified-model-catalog.ts. Functions that legacy
 * called without a settings argument (provider registry, filterModels) take the
 * session handle as their first argument, since the client cannot reach the
 * process-wide registry.
 */
import type { MenuModelCatalog, MenuModelInfo as ModelInfo, TuiModelSettings } from '../integration.js';

export type { MenuModelInfo as ModelInfo } from '../integration.js';
export type ModelSettings = TuiModelSettings;

// --- rewrite/src/model/models/model-favorites.ts (pure part)
export const FAVORITES_TAB_ID = '__favorites__';
export function serializeFavorite(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}
export const getFavoriteModelInfos = (settingsService: ModelSettings): ModelInfo[] =>
  settingsService.favoriteModelInfos();
export const toggleFavoriteModel = (settingsService: ModelSettings, provider: string, modelId: string): boolean =>
  settingsService.toggleFavorite(provider, modelId);

// --- rewrite/src/model/models/model-nicknames.ts
export const getNicknameEntries = (settingsService: ModelSettings) => settingsService.nicknameEntries();
export const getNicknameLabels = (settingsService: ModelSettings) => settingsService.nicknameLabels();
export const getNicknameModelInfos = (settingsService: ModelSettings) => settingsService.nicknameModelInfos();
export const commitNicknameEdit = (
  settingsService: ModelSettings,
  ...args: Parameters<ModelSettings['commitNickname']>
) => settingsService.commitNickname(...args);
export const removeNicknameTarget = (settingsService: ModelSettings, target: { provider: string; modelId: string }) =>
  settingsService.removeNickname(target);

// --- rewrite/src/model/models/model-tabs.ts
export const MODEL_TABS = ['favorites', 'nicknames', 'all'] as const;
export type ModelTab = (typeof MODEL_TABS)[number];
export const MODEL_TAB_LABELS: Record<ModelTab, string> = {
  favorites: 'Favorites',
  nicknames: 'Nicknames',
  all: 'All',
};
export function nextModelTab(tab: ModelTab): ModelTab {
  const index = MODEL_TABS.indexOf(tab);
  return MODEL_TABS[(index + 1) % MODEL_TABS.length]!;
}
export function previousModelTab(tab: ModelTab): ModelTab {
  const index = MODEL_TABS.indexOf(tab);
  return MODEL_TABS[(index - 1 + MODEL_TABS.length) % MODEL_TABS.length]!;
}
export function pinnedModelsForTab(
  tab: ModelTab,
  favorites: readonly ModelInfo[],
  nicknames: readonly ModelInfo[],
): ModelInfo[] {
  return tab === 'nicknames' ? [...favorites, ...nicknames] : [...favorites];
}
export function selectModelsForTab(
  models: readonly ModelInfo[],
  tab: ModelTab,
  keys: { favoriteKeys: ReadonlySet<string>; nicknameKeys: ReadonlySet<string> },
): ModelInfo[] {
  if (tab === 'favorites') {
    return models.filter((model) => keys.favoriteKeys.has(serializeFavorite(model.provider, model.id)));
  }
  if (tab === 'nicknames') {
    return models.filter((model) => keys.nicknameKeys.has(serializeFavorite(model.provider, model.id)));
  }
  return [...models];
}

// --- rewrite/src/shared/utils/ai/model-provider-arg.ts
export function parseModelProviderArg(value: string): { modelId: string; provider: string | undefined } {
  const trimmed = value.trim();
  const providerMatch = trimmed.match(/\s+--provider=(.+)$/);

  if (!providerMatch || providerMatch.index === undefined) {
    return {
      modelId: trimmed,
      provider: undefined,
    };
  }

  return {
    modelId: trimmed.slice(0, providerMatch.index).trim(),
    provider: providerMatch[1].trim() || undefined,
  };
}

// --- rewrite/src/shared/utils/ai/provider-credentials.ts and rewrite/src/model/providers/index.ts
export const getProviderCredentialSettingKey = (settingsService: ModelSettings, providerId: string) =>
  settingsService.credentialSettingKey(providerId);
export const getProviderIdForCredentialSettingKey = (settingsService: ModelSettings, key: string | undefined) =>
  settingsService.providerIdForCredentialSettingKey(key);
export const resolveProviderCredentials = (settingsService: ModelSettings, providerId: string) => ({
  unavailableReason: settingsService.unavailableReason(providerId),
});
export const hasProviderCredentials = (settingsService: ModelSettings, providerId: string) =>
  settingsService.hasProviderCredentials(providerId);
export const getAvailableProviderIds = (settingsService: ModelSettings, providerIds: string[]) =>
  settingsService.availableProviderIds(providerIds);
export const getProviderIds = (settingsService: ModelSettings) => settingsService.providerIds();
export const getAllProviders = (settingsService: ModelSettings) => settingsService.providers();
export const getProvider = (settingsService: ModelSettings, providerId: string) => {
  const label = settingsService.providerLabel(providerId);
  return label === undefined ? undefined : { id: providerId, label };
};
export const loadProviderItems = (settingsService: ModelSettings) => settingsService.providerItems();

// --- rewrite/src/model/models/model-catalog-session.ts
export const orderedProviderIds = (settingsService: ModelSettings, providerIds: string[]): string[] =>
  settingsService.orderedProviderIds(providerIds);
/** The session's catalog session; the app owns fetching, caching and failure suppression. */
export class ModelCatalogSession implements MenuModelCatalog {
  readonly #inner: MenuModelCatalog;
  constructor(deps: { settingsService: ModelSettings }) {
    this.#inner = deps.settingsService.createCatalog();
  }
  getCached(provider: string) {
    return this.#inner.getCached(provider);
  }
  load(provider: string) {
    return this.#inner.load(provider);
  }
  begin() {
    this.#inner.begin();
  }
  refresh(provider: string) {
    this.#inner.refresh(provider);
  }
  invalidate(provider: string) {
    this.#inner.invalidate(provider);
  }
  clear() {
    this.#inner.clear();
  }
}

// --- rewrite/src/shared/utils/subsequence-filter.ts
export const isSubsequenceMatch = (query: string, target: string): boolean => {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
};

// --- rewrite/src/model/models/unified-model-catalog.ts
// Model IDs use punctuation as word separators (for example, gpt-6.1-sol:batch).
// Keep fuzzy matches available, but prefer whole words, then literal substrings.
function modelMatchTier(settingsService: ModelSettings, model: ModelInfo, query: string): number {
  const label = getProvider(settingsService, model.provider)?.label ?? model.provider;
  const texts = [model.id, model.name ?? '', `${model.provider}/${model.id}`, `${label}/${model.id}`];
  let tier = 2;
  for (const text of texts) {
    const normalized = text.toLowerCase();
    let index = normalized.indexOf(query);
    while (index !== -1) {
      tier = 1;
      const before = [...normalized.slice(0, index)].at(-1);
      const after = [...normalized.slice(index + query.length)][0];
      if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after))) {
        return 0;
      }
      index = normalized.indexOf(query, index + 1);
    }
  }
  return tier;
}

export function mergeUnifiedModels(
  providerIds: readonly string[],
  catalogs: ReadonlyMap<string, readonly ModelInfo[]>,
  favorites: readonly ModelInfo[],
): ModelInfo[] {
  const catalogByKey = new Map<string, ModelInfo>();
  for (const providerId of providerIds) {
    for (const model of catalogs.get(providerId) ?? []) {
      catalogByKey.set(serializeFavorite(model.provider, model.id), model);
    }
  }

  const seen = new Set<string>();
  const merged: ModelInfo[] = [];
  for (const favorite of favorites) {
    const key = serializeFavorite(favorite.provider, favorite.id);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(catalogByKey.get(key) ?? favorite);
  }
  for (const providerId of providerIds) {
    for (const model of catalogs.get(providerId) ?? []) {
      const key = serializeFavorite(model.provider, model.id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(model);
    }
  }
  return merged;
}

export function filterUnifiedModels(
  settingsService: ModelSettings,
  models: readonly ModelInfo[],
  modelQuery: string,
  providerQuery?: string,
): ModelInfo[] {
  const providerNeedle = providerQuery?.trim();
  const providerFiltered = providerNeedle
    ? models.filter((model) => {
        const label = getProvider(settingsService, model.provider)?.label ?? model.provider;
        return isSubsequenceMatch(providerNeedle, model.provider) || isSubsequenceMatch(providerNeedle, label);
      })
    : models;
  const trimmed = modelQuery.trim();
  if (!trimmed) return [...providerFiltered];
  const modelMatches = new Set(settingsService.filterModels([...providerFiltered], trimmed));
  const matches = providerFiltered.filter((model) => {
    if (modelMatches.has(model)) return true;
    const label = getProvider(settingsService, model.provider)?.label ?? model.provider;
    return (
      isSubsequenceMatch(trimmed, model.provider) ||
      isSubsequenceMatch(trimmed, label) ||
      isSubsequenceMatch(trimmed, `${model.provider}/${model.id}`) ||
      isSubsequenceMatch(trimmed, `${label}/${model.id}`)
    );
  });
  return matches
    .map((model) => ({ model, tier: modelMatchTier(settingsService, model, trimmed.toLowerCase()) }))
    .sort((a, b) => a.tier - b.tier)
    .map(({ model }) => model);
}
