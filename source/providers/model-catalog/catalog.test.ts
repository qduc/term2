import { describe, expect, it } from 'vitest';
import { CATALOG_META, MODEL_CATALOG } from './catalog.generated.js';
import {
  getCatalogModel,
  getModelContextWindow,
  lookupModel,
  lookupModelAnyProvider,
  type ModelCatalogData,
} from './catalog.js';

/**
 * Synthetic catalog with a prefix chain of distinct values so the
 * longest-prefix and exact-match rules are distinguishable:
 *   claude-sonnet-4-6-20251120 is a dash-bounded extension of claude-sonnet-4-6
 *   claude-sonnet-4-5-20250929 is a dash-bounded extension of claude-sonnet-4-5
 */
const syntheticCatalog: ModelCatalogData = {
  openai: {
    'gpt-4': { contextWindow: 8192, maxTokens: 8192 },
    'gpt-4o': { contextWindow: 128000, maxTokens: 16384 },
    'claude-sonnet-4-6': { contextWindow: 1000000, maxTokens: 128000 },
    'claude-sonnet-4-6-20251120': { contextWindow: 1000000, maxTokens: 64000 },
    'claude-sonnet-4-5': { contextWindow: 1000000, maxTokens: 64000 },
    'claude-sonnet-4-5-20250929': { contextWindow: 900000, maxTokens: 32000 },
  },
};

describe('lookupModel', () => {
  it('returns the entry for an exact model id', () => {
    expect(lookupModel(syntheticCatalog, 'openai', 'gpt-4o')).toEqual({ contextWindow: 128000, maxTokens: 16384 });
  });

  it('matches provider and model ids case-insensitively', () => {
    expect(lookupModel(syntheticCatalog, 'OpenAI', 'GPT-4O')).toEqual({ contextWindow: 128000, maxTokens: 16384 });
  });

  it('returns undefined for an unknown provider', () => {
    expect(lookupModel(syntheticCatalog, 'not-a-provider', 'gpt-4o')).toBeUndefined();
  });

  it('returns undefined for an unknown model', () => {
    expect(lookupModel(syntheticCatalog, 'openai', 'model-that-does-not-exist')).toBeUndefined();
  });

  it('falls back to the longest dash-bounded catalog id prefix of a dated alias', () => {
    // claude-sonnet-4-5 and claude-sonnet-4-5-20250929 are both dash-bounded
    // prefixes of ...-extra; the longer one (maxTokens 32000) must win.
    expect(lookupModel(syntheticCatalog, 'openai', 'claude-sonnet-4-5-20250929-extra')).toEqual({
      contextWindow: 900000,
      maxTokens: 32000,
    });
  });

  it('does not match a prefix that ends mid-word (gpt-4 must not match gpt-4oz)', () => {
    expect(lookupModel(syntheticCatalog, 'openai', 'gpt-4oz')).toBeUndefined();
  });

  it('prefers an exact entry over a prefix match that would also qualify', () => {
    // claude-sonnet-4-6 is a dash-bounded prefix of claude-sonnet-4-6-20251120,
    // but the exact entry (maxTokens 64000) wins over the prefix (128000).
    expect(lookupModel(syntheticCatalog, 'openai', 'claude-sonnet-4-6-20251120')?.maxTokens).toBe(64000);
  });
});

describe('lookupModel across a vendor/ prefix', () => {
  // Aggregator catalogs key models by `vendor/model`, while the same model
  // configured behind a gateway is usually a bare id (and occasionally the
  // reverse). Neither side's id is wrong, so matching drops the vendor segment.
  const vendorCatalog: ModelCatalogData = {
    aggregator: {
      'deepseek/deepseek-v4-flash': { contextWindow: 1048576, maxTokens: 393216 },
      'gpt-4o': { contextWindow: 128000, maxTokens: 16384 },
    },
  };

  it('matches a bare model id against a vendor-qualified catalog id', () => {
    expect(lookupModel(vendorCatalog, 'aggregator', 'deepseek-v4-flash')?.contextWindow).toBe(1048576);
  });

  it('matches a bare dated/variant alias by prefix after dropping the vendor segment', () => {
    expect(lookupModel(vendorCatalog, 'aggregator', 'deepseek-v4-flash-flex')?.contextWindow).toBe(1048576);
  });

  it('matches a vendor-qualified request against a bare catalog id', () => {
    expect(lookupModel(vendorCatalog, 'aggregator', 'openai/gpt-4o')?.maxTokens).toBe(16384);
  });

  it('still refuses a vendor-stripped prefix that ends mid-word', () => {
    expect(lookupModel(vendorCatalog, 'aggregator', 'deepseek-v4-flashy')).toBeUndefined();
  });

  it('prefers a vendor-stripped exact id over a truncated prefix of the full id', () => {
    const mixed: ModelCatalogData = {
      aggregator: {
        // A dash-bounded prefix of the request: the right family, wrong model.
        'deepseek-v4': { contextWindow: 1, maxTokens: 1 },
        // Exactly the requested model once the vendor segment is dropped.
        'deepseek/deepseek-v4-flash': { contextWindow: 2, maxTokens: 2 },
      },
    };
    expect(lookupModel(mixed, 'aggregator', 'deepseek-v4-flash')?.maxTokens).toBe(2);
  });

  it('still prefers a full-id exact entry over a vendor-stripped one', () => {
    const mixed: ModelCatalogData = {
      aggregator: {
        'deepseek-v4-flash': { contextWindow: 1, maxTokens: 1 },
        'deepseek/deepseek-v4-flash': { contextWindow: 2, maxTokens: 2 },
      },
    };
    expect(lookupModel(mixed, 'aggregator', 'deepseek-v4-flash')?.maxTokens).toBe(1);
  });
});

describe('lookupModelAnyProvider', () => {
  const crossProviderCatalog: ModelCatalogData = {
    // Iterated first: only a prefix of the requested dated alias.
    gateway: { 'claude-sonnet-4-5': { contextWindow: 1000000, maxTokens: 64000 } },
    // Iterated second: an exact hit, which must win over the earlier prefix.
    anthropic: { 'claude-sonnet-4-5-20250929': { contextWindow: 900000, maxTokens: 32000 } },
  };

  it('matches a dated alias by prefix under a provider that is not the requested one', () => {
    expect(lookupModelAnyProvider(syntheticCatalog, 'claude-sonnet-4-6-20251120-preview')?.maxTokens).toBe(64000);
  });

  it('prefers an exact hit under any provider over a prefix hit under another', () => {
    expect(lookupModelAnyProvider(crossProviderCatalog, 'claude-sonnet-4-5-20250929')?.maxTokens).toBe(32000);
  });

  it('returns undefined when no provider carries the model', () => {
    expect(lookupModelAnyProvider(syntheticCatalog, 'model-that-does-not-exist')).toBeUndefined();
  });
});

describe('getModelContextWindow over the vendored catalog', () => {
  it('returns the current catalog entry for a provider/model pair', () => {
    const [modelId, info] = Object.entries(MODEL_CATALOG.openai)[0]!;
    expect(getCatalogModel('openai', modelId)).toEqual(info);
    expect(getModelContextWindow('openai', modelId)).toBe(info.contextWindow);
  });

  it('returns undefined for an unknown model id', () => {
    expect(getModelContextWindow('openai', 'model-that-does-not-exist')).toBeUndefined();
  });

  it('resolves a known model id through an unknown provider via cross-provider fallback', () => {
    // term2 users may run a catalog model under a custom or unregistered
    // provider (settings falls back to the default provider, which never
    // scopes to the catalog entry). The model id alone must still resolve.
    const [modelId, info] = Object.entries(MODEL_CATALOG.openai)[0]!;
    expect(getModelContextWindow('custom-local-llm', modelId)).toBe(info.contextWindow);
  });

  it('returns undefined when neither the provider nor the model id is known', () => {
    expect(getModelContextWindow('custom-local-llm', 'model-that-does-not-exist')).toBeUndefined();
  });

  it('returns metadata for a vendored model through a provider fallback', () => {
    const [modelId, info] = Object.entries(MODEL_CATALOG.openai)[0]!;
    expect(getCatalogModel('custom-local-llm', modelId)).toEqual(info);
  });
});

describe('vendored catalog data contract', () => {
  it('covers the built-in providers term2 ships with', () => {
    expect(Object.keys(MODEL_CATALOG).sort()).toEqual(['anthropic', 'codex', 'moonshotai', 'openai', 'openrouter']);
  });

  it('has a positive contextWindow for every model', () => {
    for (const [provider, models] of Object.entries(MODEL_CATALOG)) {
      for (const [modelId, info] of Object.entries(models)) {
        expect(info.contextWindow, `${provider}/${modelId} contextWindow`).toBeGreaterThan(0);
        if (info.maxTokens !== undefined) {
          expect(info.maxTokens, `${provider}/${modelId} maxTokens`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('carries a standard price for every vendored model', () => {
    const unpriced = Object.entries(MODEL_CATALOG).flatMap(([provider, models]) =>
      Object.entries(models)
        .filter(([, entry]) => entry.inputPricePerMTok === undefined || entry.outputPricePerMTok === undefined)
        .map(([model]) => `${provider}/${model}`),
    );
    expect(unpriced).toEqual([]);
  });

  it('keeps model ids lowercase', () => {
    for (const models of Object.values(MODEL_CATALOG)) {
      for (const modelId of Object.keys(models)) {
        expect(modelId).toBe(modelId.toLowerCase());
      }
    }
  });

  it('records a parseable generation timestamp', () => {
    expect(Number.isNaN(Date.parse(CATALOG_META.generatedAt))).toBe(false);
    expect(CATALOG_META.schemaVersion).toBe(2);
  });
});
