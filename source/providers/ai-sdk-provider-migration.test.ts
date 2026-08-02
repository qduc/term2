import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createOpenAICompatibleProviderDefinition } from './openai-compatible-lazy.js';
import type { ProviderDeps } from './registry.js';

const providerFiles = [
  'source/providers/ai-sdk-openrouter.provider.ts',
  'source/providers/ai-sdk-google.provider.ts',
  'source/providers/ai-sdk-anthropic.provider.ts',
];

it('lazy provider factories resolve application-owned streamed models for every configured provider family', async () => {
  const cases = [
    { id: 'lazy-anthropic', type: 'anthropic', model: 'claude-test' },
    { id: 'lazy-google', type: 'google', model: 'gemini-test' },
    { id: 'lazy-custom', type: 'openai-compatible', model: 'custom-test' },
  ] as const;

  for (const testCase of cases) {
    const deps: ProviderDeps = {
      settingsService: {
        get: (key: string) => (key === 'agent.model' ? testCase.model : undefined),
        getDynamic: (key: string) =>
          key === 'providers'
            ? [
                {
                  id: testCase.id,
                  name: testCase.id,
                  type: testCase.type,
                  baseUrl: 'https://provider.test/v1',
                  apiKey: 'test-key',
                },
              ]
            : undefined,
      } as any,
      loggingService: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} } as any,
    };
    const definition = createOpenAICompatibleProviderDefinition({ name: testCase.id, type: testCase.type });
    const model = await definition.createStreamedModel!(testCase.model, deps);

    expect(model, `${testCase.type} factory must resolve a streamed model`).toHaveProperty('stream');
    expect(typeof model.stream).toBe('function');
  }
});

it('AI SDK providers expose only the application-owned streamed model seam', async () => {
  const sources = await Promise.all(providerFiles.map((file) => readFile(file, 'utf8')));
  for (const source of sources) {
    expect(source).not.toMatch(/LegacyModel|LegacyModelProvider|adaptStreamedModelTurnForAgents|\bgetModel\s*\(/);
    expect(source).toContain('getStreamedModel');
  }
});
