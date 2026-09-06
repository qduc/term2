import { getProvider } from '../../providers/index.js';
import { isSubsequenceMatch } from '../../utils/subsequence-filter.js';
import { filterModels, type ModelInfo } from '../model-service.js';
import { serializeFavorite } from './model-favorites.js';

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
  return providerFiltered.filter((model) => {
    if (modelMatches.has(model)) return true;
    const label = getProvider(model.provider)?.label ?? model.provider;
    return (
      isSubsequenceMatch(trimmed, model.provider) ||
      isSubsequenceMatch(trimmed, label) ||
      isSubsequenceMatch(trimmed, `${model.provider}/${model.id}`) ||
      isSubsequenceMatch(trimmed, `${label}/${model.id}`)
    );
  });
}
