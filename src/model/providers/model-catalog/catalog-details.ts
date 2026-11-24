/**
 * Display details for a model list: max output and prices from the vendored
 * catalog, only for an exact model-id match (a near-miss would show another model's price).
 */
import { getExactCatalogModel, type CatalogModelInfo } from './catalog.js';

/** USD per million tokens. Absent prices are unknown, not free. */
export type CatalogPrices = {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
};
export type CatalogDisplayDetails = {
  maxOutputTokens?: number;
  pricing?: CatalogPrices & { tiers?: (CatalogPrices & { inputTokensAbove: number })[] };
};

const finitePrice = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function pricesOf(info: Omit<CatalogModelInfo, 'contextWindow' | 'maxTokens' | 'pricingTiers'>): CatalogPrices {
  const entries = {
    inputPerMTok: finitePrice(info.inputPricePerMTok),
    outputPerMTok: finitePrice(info.outputPricePerMTok),
    cacheReadPerMTok: finitePrice(info.cacheReadPricePerMTok),
    cacheWritePerMTok: finitePrice(info.cacheWritePricePerMTok),
  };
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as CatalogPrices;
}

/** Max output and prices from the vendored catalog, for the model list's display only. */
export function catalogDetails(provider: string, modelId: string): CatalogDisplayDetails {
  const info = getExactCatalogModel(provider, modelId);
  if (!info) return {};
  const base = pricesOf(info);
  const tiers = (info.pricingTiers ?? [])
    // Same bounds the web client validates, so a catalog oddity can't fail the whole model list.
    .filter((tier) => Number.isSafeInteger(tier.inputTokensAbove) && tier.inputTokensAbove > 0)
    .slice(0, 8)
    .map((tier) => ({ inputTokensAbove: tier.inputTokensAbove, ...pricesOf(tier) }));
  const hasPricing = Object.keys(base).length > 0 || tiers.length > 0;
  return {
    ...(typeof info.maxTokens === 'number' && Number.isSafeInteger(info.maxTokens) && info.maxTokens > 0
      ? { maxOutputTokens: info.maxTokens }
      : {}),
    ...(hasPricing ? { pricing: { ...base, ...(tiers.length > 0 ? { tiers } : {}) } } : {}),
  };
}
