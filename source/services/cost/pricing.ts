/**
 * Pricing lookup backed by the vendored model catalog plus the versioned Term2
 * tier overlay.
 *
 * Matching reuses the catalog's exact/dash-bounded model matching, preferring
 * the named provider and falling back to the same model under any other
 * provider. The fallback exists because a model id identifies a model more
 * reliably than a provider id does: term2 users reach catalog models through
 * proxies and OpenAI-compatible gateways whose provider id is never in the
 * catalog, and no price at all is worse than a rate that is right for the
 * model but possibly wrong for the vendor. A borrowed rate is flagged on the
 * result (`pricedFromProvider`) so the cost record says whose price it used;
 * gateways do resell at their own margins, so a flagged charge is an estimate.
 */
import {
  CATALOG_META,
  MODEL_CATALOG,
  type GeneratedCatalogModel,
} from '../../providers/model-catalog/catalog.generated.js';
import { findModelMatches, lookupModel } from '../../providers/model-catalog/catalog.js';
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

  // Standard tier: the named provider first, then the same model anywhere.
  const catalog = MODEL_CATALOG as Record<string, Record<string, GeneratedCatalogModel>>;
  const ownPrice = entryToCatalogPrice(lookupModel(catalog, providerId, modelId) ?? {});
  if (ownPrice) {
    return { found: true, price: ownPrice };
  }

  // Fall back to the best-matching entry under another provider that actually
  // carries a price; an unpriced entry is no better than a miss.
  for (const match of findModelMatches(catalog, modelId)) {
    if (match.providerId === providerId) continue;
    const price = entryToCatalogPrice(match.info);
    if (price) {
      return { found: true, price, pricedFromProvider: match.providerId };
    }
  }

  return { found: false, reason: catalog[providerId] ? 'unknown_model' : 'unknown_provider' };
}

/** Catalog provenance string recorded on catalog-priced requests. */
export function getCatalogPricingVersion(): string {
  return CATALOG_PRICING_VERSION;
}

/** Catalog provenance string recorded on overlay-priced requests. */
export function getOverlayPricingVersion(): string {
  return OVERLAY_PRICING_VERSION;
}
