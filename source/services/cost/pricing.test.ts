import { describe, expect, it, vi } from 'vitest';
import { getCatalogPricingVersion, getModelPricing, getOverlayPricingVersion } from './pricing.js';

// Pricing behavior must not depend on today's upstream model list or rates.
// The live generated catalog's shape and price coverage are checked in catalog.test.ts.
vi.mock('../../providers/model-catalog/catalog.generated.js', () => ({
  CATALOG_META: { schemaVersion: 2, source: 'pi-ai@test' },
  MODEL_CATALOG: {
    openai: {
      'gpt-4.1': {
        contextWindow: 128000,
        inputPricePerMTok: 2,
        outputPricePerMTok: 8,
        cacheReadPricePerMTok: 0.5,
        cacheWritePricePerMTok: 0,
      },
      'gpt-5.6-sol': { contextWindow: 272000, inputPricePerMTok: 1, outputPricePerMTok: 3 },
    },
    codex: { 'gpt-5.6-sol': { contextWindow: 128000, inputPricePerMTok: 2, outputPricePerMTok: 4 } },
    anthropic: {
      'claude-sonnet-4-6': { contextWindow: 1000000, inputPricePerMTok: 3, outputPricePerMTok: 15 },
    },
    openrouter: {
      'deepseek/deepseek-v4-flash': { contextWindow: 1048576, inputPricePerMTok: 0.2, outputPricePerMTok: 0.5 },
    },
  },
}));

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

  it("borrows another provider's rate for a model reached through a gateway, and says whose", () => {
    // A proxy/gateway provider id is never in the catalog, but the model is
    // the same model, so its rate is usable — flagged with its source.
    const result = getModelPricing('custom-local-llm', 'gpt-5.6-sol', 'standard');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.pricedFromProvider).toMatch(/^(openai|codex)$/);
    expect(result.price).toEqual(
      (getModelPricing(result.pricedFromProvider!, 'gpt-5.6-sol', 'standard') as { price: unknown }).price,
    );
  });

  it('does not flag a borrowed provider when the requested provider prices the model itself', () => {
    const result = getModelPricing('openai', 'gpt-4.1', 'standard');
    expect(result.found && result.pricedFromProvider).toBeUndefined();
  });

  it('prices a bare model id against a vendor-qualified catalog entry', () => {
    // Regression: gateways expose `deepseek-v4-flash`, while the catalog keys
    // the same model as `deepseek/deepseek-v4-flash`, so every request on such
    // a model was unpriced — and a run with no priced request shows no cost at
    // all in the status bar.
    const result = getModelPricing('opencode', 'deepseek-v4-flash', 'standard');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.price.inputPerMTok).toBeGreaterThan(0);
    expect(result.pricedFromProvider).toBe('openrouter');
  });

  it('prices a variant suffix on a vendor-qualified catalog entry', () => {
    const result = getModelPricing('neuralwatt', 'deepseek-v4-flash-flex', 'standard');
    expect(result.found).toBe(true);
  });

  it('borrows a rate for a dated alias reached through a gateway', () => {
    const result = getModelPricing('my-gateway', 'claude-sonnet-4-6-20251120', 'standard');
    expect(result.found).toBe(true);
    if (result.found) expect(result.pricedFromProvider).toBe('anthropic');
  });

  it('reports unknown_model for a known provider with an unknown model id', () => {
    expect(getModelPricing('openai', 'model-that-does-not-exist', 'standard')).toEqual({
      found: false,
      reason: 'unknown_model',
    });
  });

  it('reports unknown_provider when neither the provider nor the model id is known', () => {
    expect(getModelPricing('not-a-provider', 'model-that-does-not-exist', 'standard')).toEqual({
      found: false,
      reason: 'unknown_provider',
    });
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
