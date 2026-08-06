import { describe, expect, it } from 'vitest';
import { CATALOG_META, MODEL_CATALOG } from './catalog.generated.js';
import { getCatalogModel, getModelContextWindow, lookupModel, type ModelCatalogData } from './catalog.js';

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

describe('getModelContextWindow over the vendored catalog', () => {
  it('returns the context window for a known OpenAI model', () => {
    expect(getModelContextWindow('openai', 'gpt-5.6-sol')).toBe(272000);
  });

  it('returns the context window for a dated Claude alias via prefix fallback', () => {
    expect(getModelContextWindow('anthropic', 'claude-sonnet-4-6-20251120')).toBe(1000000);
  });

  it('returns undefined for an unknown model id', () => {
    expect(getModelContextWindow('openai', 'model-that-does-not-exist')).toBeUndefined();
  });

  it('resolves a known model id through an unknown provider via cross-provider fallback', () => {
    // term2 users may run a catalog model under a custom or unregistered
    // provider (settings falls back to the default provider, which never
    // scopes to the catalog entry). The model id alone must still resolve.
    expect(getModelContextWindow('custom-local-llm', 'claude-sonnet-4-6')).toBe(1000000);
    expect(getModelContextWindow('anthropic', 'gpt-5.6-sol')).toBe(272000);
  });

  it('returns undefined when neither the provider nor the model id is known', () => {
    expect(getModelContextWindow('custom-local-llm', 'model-that-does-not-exist')).toBeUndefined();
  });

  it('prefers the provider-scoped entry over a cross-provider fallback', () => {
    // gpt-5.6-sol exists under both openai and codex; the openai scope must win.
    expect(getCatalogModel('openai', 'gpt-5.6-sol')).toMatchObject({ contextWindow: 272000 });
  });

  it('exposes maxTokens alongside contextWindow', () => {
    expect(getCatalogModel('openai', 'gpt-4o')).toMatchObject({ contextWindow: 128000, maxTokens: 16384 });
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

  it('keeps model ids lowercase', () => {
    for (const models of Object.values(MODEL_CATALOG)) {
      for (const modelId of Object.keys(models)) {
        expect(modelId).toBe(modelId.toLowerCase());
      }
    }
  });

  it('records a parseable generation timestamp', () => {
    expect(Number.isNaN(Date.parse(CATALOG_META.generatedAt))).toBe(false);
    expect(CATALOG_META.schemaVersion).toBe(1);
  });
});
