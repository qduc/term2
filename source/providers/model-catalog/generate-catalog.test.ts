import { describe, expect, it } from 'vitest';
import { generateCatalogSource, VENDORED_PI_PROVIDERS, type PiProviderData } from './generate-catalog.js';

const META = { schemaVersion: 1, generatedAt: '2026-07-29T22:27:21.904Z', source: 'pi-ai@0.83.0' };

const piData: Record<string, PiProviderData> = {
  openai: {
    'openai-responses': {
      'gpt-4o': { contextWindow: 128000, maxTokens: 16384, name: 'GPT-4o' },
      'gpt-4o-mini': { contextWindow: 128000, maxTokens: 16384, name: 'GPT-4o mini' },
      'gpt-4-turbo': { contextWindow: 128000, maxTokens: 16384, name: 'GPT-4 Turbo' },
    },
  },
  'openai-codex': {
    'openai-codex-responses': {
      'gpt-5.3-codex-spark': { contextWindow: 128000, maxTokens: 128000, name: 'GPT-5.3 Codex Spark' },
    },
  },
  anthropic: {
    'anthropic-messages': {
      'claude-sonnet-4-5': { contextWindow: 1000000, maxTokens: 64000, name: 'Claude Sonnet 4.5' },
      'no-context-entry': { maxTokens: 64000, name: 'Missing context window' },
    },
  },
};

describe('generateCatalogSource', () => {
  it('maps pi-ai provider files onto term2 provider ids', () => {
    const source = generateCatalogSource(piData, META);
    expect(source).toContain('codex: {');
    expect(source).toContain("'gpt-5.3-codex-spark': { contextWindow: 128000, maxTokens: 128000 }");
  });

  it('sorts model ids within each provider for stable diffs', () => {
    const source = generateCatalogSource(piData, META);
    // gpt-4o is a prefix of gpt-4o-mini, so any lexicographic sort orders them this way.
    const gpt4o = source.indexOf("'gpt-4o'");
    const gpt4oMini = source.indexOf("'gpt-4o-mini'");
    expect(gpt4o).toBeGreaterThan(-1);
    expect(gpt4oMini).toBeGreaterThan(gpt4o);
  });

  it('skips entries without a context window', () => {
    const source = generateCatalogSource(piData, META);
    expect(source).not.toContain('no-context-entry');
  });

  it('drops pi-specific fields and keeps only contextWindow/maxTokens', () => {
    const source = generateCatalogSource(piData, META);
    expect(source).not.toContain('"name"');
    expect(source).not.toContain('openai-responses');
  });

  it('embeds the catalog meta with generatedAt and source', () => {
    const source = generateCatalogSource(piData, META);
    expect(source).toContain("generatedAt: '2026-07-29T22:27:21.904Z'");
    expect(source).toContain("source: 'pi-ai@0.83.0'");
    expect(source).toContain('schemaVersion: 1');
  });

  it('emits a module that a consumer can import', () => {
    const source = generateCatalogSource(piData, META);
    expect(source).toMatch(/export const MODEL_CATALOG = \{/);
    expect(source).toMatch(/export interface GeneratedCatalogModel/);
  });

  it('lists the vendored providers term2 maps from pi-ai', () => {
    expect(VENDORED_PI_PROVIDERS.map((p) => p.provider).sort()).toEqual([
      'anthropic',
      'codex',
      'moonshotai',
      'openai',
      'openrouter',
    ]);
  });
});
