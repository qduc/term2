/**
 * Provider-scoped pricing lookup backed by the vendored model catalog plus
 * the versioned Term2 tier overlay.
 *
 * Matching reuses the catalog's exact/dash-bounded model matching inside the
 * named provider only. Cross-provider model fallback (`getCatalogModel`) is
 * deliberately NOT used for pricing: a price is a provider-specific contract,
 * and borrowing another provider's rate would misreport a bill.
 */
import {
  CATALOG_META,
  MODEL_CATALOG,
  type GeneratedCatalogModel,
} from '../../providers/model-catalog/catalog.generated.js';
import { lookupModel } from '../../providers/model-catalog/catalog.js';
import type { CatalogPrice, PricingLookupResult, ServiceTier } from './model-cost.js';
import { TIER_PRICING_OVERLAY, type OverlayTier } from './pricing-overlay.js';

const CATALOG_PRICING_VERSION = `catalog:v${CATALOG_META.schemaVersion}@${CATALOG_META.source}`;
const OVERLAY_PRICING_VERSION = 'term2-overlay:v1';

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

function entryToCatalogPrice(entry: {
  inputPricePerMTok?: number;
  outputPricePerMTok?: number;
  cacheReadPricePerMTok?: number;
  cacheWritePricePerMTok?: number;
}): CatalogPrice | undefined {
  if (typeof entry.inputPricePerMTok !== 'number' || typeof entry.outputPricePerMTok !== 'number') {
    return undefined;
  }
  return {
    inputPerMTok: entry.inputPricePerMTok,
    outputPerMTok: entry.outputPricePerMTok,
    ...(entry.cacheReadPricePerMTok !== undefined ? { cacheReadPerMTok: entry.cacheReadPricePerMTok } : {}),
    ...(entry.cacheWritePricePerMTok !== undefined ? { cacheWritePerMTok: entry.cacheWritePricePerMTok } : {}),
  };
}

/**
 * Look up the price for a provider/model/service-tier combination.
 *
 * Returns a typed miss for unknown providers, models without a price, and
 * unsupported tiers. Standard pricing is never treated as flex/batch pricing.
 */
export function getModelPricing(provider: string, model: string, tier: ServiceTier): PricingLookupResult {
  const providerId = normalizeId(provider);
  const modelId = normalizeId(model);

  // Service tiers that the catalog does not cover resolve through the overlay
  // and fail closed when the tier is unknown or unsupported.
  if (tier === 'flex' || tier === 'batch') {
    const overlayEntry = TIER_PRICING_OVERLAY[providerId]?.[modelId]?.[tier as OverlayTier];
    if (overlayEntry) {
      const { sourceUrl: _sourceUrl, checkedAt: _checkedAt, ...price } = overlayEntry;
      return { found: true, price };
    }
    return { found: false, reason: 'unknown_tier' };
  }
  if (tier === 'unknown') {
    return { found: false, reason: 'unknown_tier' };
  }

  // Standard tier: provider-scoped catalog lookup only.
  const catalog = MODEL_CATALOG as Record<string, Record<string, GeneratedCatalogModel>>;
  const providerCatalog = catalog[providerId];
  if (!providerCatalog) {
    return { found: false, reason: 'unknown_provider' };
  }
  const entry = lookupModel(catalog, providerId, modelId);
  if (!entry) {
    return { found: false, reason: 'unknown_model' };
  }
  const price = entryToCatalogPrice(entry);
  if (!price) {
    // The model exists in the catalog but carries no vendored price.
    return { found: false, reason: 'unknown_model' };
  }
  return { found: true, price };
}

/** Catalog provenance string recorded on catalog-priced requests. */
export function getCatalogPricingVersion(): string {
  return CATALOG_PRICING_VERSION;
}

/** Catalog provenance string recorded on overlay-priced requests. */
export function getOverlayPricingVersion(): string {
  return OVERLAY_PRICING_VERSION;
}
