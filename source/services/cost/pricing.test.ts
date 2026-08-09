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
