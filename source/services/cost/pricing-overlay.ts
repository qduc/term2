/**
 * Versioned Term2 pricing overlay for service tiers that the vendored pi-ai
 * catalog does not cover. pi-ai carries standard per-million-token prices but
 * no flex/batch tier prices, so those live here as explicit, sourced snapshots.
 *
 * Standard pricing must never be reused for flex/batch; a tier without an
 * overlay entry fails closed to `unknown_tier` in `getModelPricing`.
 */
import type { CatalogPrice } from './model-cost.js';

/** One sourced tier price snapshot. */
export interface TierPricingOverlayEntry extends CatalogPrice {
  /** Official pricing documentation the numbers were taken from. */
  sourceUrl: string;
  /** ISO date the entry was checked against that documentation. */
  checkedAt: string;
}

export type OverlayTier = 'flex' | 'batch';

/** provider id -> model id -> tier -> sourced price. */
export type TierPricingOverlay = Record<string, Record<string, Partial<Record<OverlayTier, TierPricingOverlayEntry>>>>;

const OPENAI_PRICING_URL = 'https://platform.openai.com/docs/pricing';
const CHECKED_AT = '2026-07-29';

/**
 * Flex service tier: OpenAI charges 50% of standard input/output/cache prices
 * on eligible GPT-5.x models. Only entries verified against the pricing
 * documentation are listed; anything else fails closed.
 */
export const TIER_PRICING_OVERLAY: TierPricingOverlay = {
  openai: {
    'gpt-5.4': {
      flex: {
        inputPerMTok: 1.25,
        outputPerMTok: 7.5,
        cacheReadPerMTok: 0.125,
        sourceUrl: OPENAI_PRICING_URL,
        checkedAt: CHECKED_AT,
      },
    },
    'gpt-5.4-mini': {
      flex: {
        inputPerMTok: 0.375,
        outputPerMTok: 2.25,
        cacheReadPerMTok: 0.0375,
        sourceUrl: OPENAI_PRICING_URL,
        checkedAt: CHECKED_AT,
      },
    },
    'gpt-5.5': {
      flex: {
        inputPerMTok: 2.5,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.25,
        sourceUrl: OPENAI_PRICING_URL,
        checkedAt: CHECKED_AT,
      },
    },
  },
};
