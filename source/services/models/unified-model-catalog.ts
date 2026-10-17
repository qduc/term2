import { getProvider } from '../../providers/index.js';
import { isSubsequenceMatch } from '../../utils/subsequence-filter.js';
import { filterModels, type ModelInfo } from '../model-service.js';
import { serializeFavorite } from './model-favorites.js';

// Model IDs use punctuation as word separators (for example, gpt-6.1-sol:batch).
// Keep fuzzy matches available, but prefer whole words, then literal substrings.
function modelMatchTier(model: ModelInfo, query: string): number {
  const label = getProvider(model.provider)?.label ?? model.provider;
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
  models: readonly ModelInfo[],
  modelQuery: string,
  providerQuery?: string,
): ModelInfo[] {
  const providerNeedle = providerQuery?.trim();
  const providerFiltered = providerNeedle
    ? models.filter((model) => {
        const label = getProvider(model.provider)?.label ?? model.provider;
        return isSubsequenceMatch(providerNeedle, model.provider) || isSubsequenceMatch(providerNeedle, label);
      })
    : models;
  const trimmed = modelQuery.trim();
  if (!trimmed) return [...providerFiltered];
  const modelMatches = new Set(filterModels([...providerFiltered], trimmed));
  const matches = providerFiltered.filter((model) => {
    if (modelMatches.has(model)) return true;
    const label = getProvider(model.provider)?.label ?? model.provider;
    return (
      isSubsequenceMatch(trimmed, model.provider) ||
      isSubsequenceMatch(trimmed, label) ||
      isSubsequenceMatch(trimmed, `${model.provider}/${model.id}`) ||
      isSubsequenceMatch(trimmed, `${label}/${model.id}`)
    );
  });
  return matches
    .map((model) => ({ model, tier: modelMatchTier(model, trimmed.toLowerCase()) }))
    .sort((a, b) => a.tier - b.tier)
    .map(({ model }) => model);
}
