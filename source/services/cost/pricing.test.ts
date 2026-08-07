import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from '../../providers/model-catalog/catalog.generated.js';
import { getCatalogPricingVersion, getModelPricing, getOverlayPricingVersion } from './pricing.js';

describe('getModelPricing', () => {
  it('returns the standard price for a known provider/model with cache rates', () => {
    const result = getModelPricing('openai', 'gpt-4.1', 'standard');
    expect(result).toEqual({
      found: true,
      price: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5, cacheWritePerMTok: 0 },
    });
  });

  it('matches a dated alias through dash-bounded prefix matching inside the provider', () => {
    const result = getModelPricing('anthropic', 'claude-sonnet-4-6-20251120', 'standard');
    expect(result.found).toBe(true);
  });

  it('never falls back across providers for pricing', () => {
    // gpt-5.6-sol exists under both openai and codex. A custom provider id that
    // is not in the catalog must NOT resolve via another provider's price.
    expect(getModelPricing('custom-local-llm', 'gpt-5.6-sol', 'standard')).toEqual({
      found: false,
      reason: 'unknown_provider',
    });
  });

  it('reports unknown_model for a known provider with an unknown model id', () => {
    expect(getModelPricing('openai', 'model-that-does-not-exist', 'standard')).toEqual({
      found: false,
      reason: 'unknown_model',
    });
  });

  it('reports unknown_provider for an unknown provider', () => {
    expect(getModelPricing('not-a-provider', 'gpt-4.1', 'standard')).toEqual({
      found: false,
      reason: 'unknown_provider',
    });
  });

  it('every vendored catalog model with a context window carries a standard price', () => {
    // The vendored pi-ai snapshot prices every model it lists. If a future
    // snapshot adds an unpriced model, this test pinpoints it so the pricing
    // path can fail closed deliberately rather than silently.
    const unpriced = Object.entries(MODEL_CATALOG).flatMap(([provider, models]) =>
      Object.entries(models)
        .filter(([, entry]) => entry.inputPricePerMTok === undefined)
        .map(([model]) => `${provider}/${model}`),
    );
    expect(unpriced).toEqual([]);
  });

  it('resolves a flex tier through the overlay with the flex price', () => {
    const result = getModelPricing('openai', 'gpt-5.4', 'flex');
    expect(result).toEqual({
      found: true,
      price: { inputPerMTok: 1.25, outputPerMTok: 7.5, cacheReadPerMTok: 0.125 },
    });
  });

  it('never treats standard pricing as flex/batch pricing', () => {
    // gpt-5.4 has a standard price but no batch overlay entry: batch fails closed.
    expect(getModelPricing('openai', 'gpt-5.4', 'batch')).toEqual({
      found: false,
      reason: 'unknown_tier',
    });
    // And a model with no overlay at all fails closed even though it is priced
    // on the standard tier.
    expect(getModelPricing('openai', 'gpt-4.1', 'flex')).toEqual({
      found: false,
      reason: 'unknown_tier',
    });
  });

  it('fails closed for an unknown tier', () => {
    expect(getModelPricing('openai', 'gpt-4.1', 'unknown')).toEqual({
      found: false,
      reason: 'unknown_tier',
    });
  });

  it('matches provider and model ids case-insensitively', () => {
    expect(getModelPricing('OpenAI', 'GPT-4.1', 'standard').found).toBe(true);
  });
});

describe('pricing provenance', () => {
  it('exposes catalog and overlay versions', () => {
    expect(getCatalogPricingVersion()).toMatch(/^catalog:v2@pi-ai/);
    expect(getOverlayPricingVersion()).toBe('term2-overlay:v1');
  });
});
