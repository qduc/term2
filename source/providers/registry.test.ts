import { it, expect } from 'vitest';
import { z } from 'zod';
import { getProvider, getAllProviders, getProviderIds, sortProvidersByOrder } from './index.js';
import { createApplicationCompatibilityRunner, settleProviderRun } from './registry.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';

const AGENT = { name: 'probe', instructions: 'Answer.', model: 'test-model', tools: [] };

function textModel(text: string): StreamedModelTurn {
  return {
    async *stream() {
      yield { type: 'text_delta', text };
      yield {
        type: 'completion',
        responseId: 'resp-1',
        usage: { inputTokens: 3, outputTokens: 4 },
        output: [{ type: 'message', content: [{ type: 'text', text }] }],
      };
    },
  };
}

/**
 * Pins the contract the result-shaped callers (edit healing, the mentor) rely
 * on: `run` hands back a live stream, so only `runToCompletion` can be read
 * synchronously for final text and usage.
 */
it('runToCompletion returns a settled run carrying finalOutput and usage', async () => {
  const runner = createApplicationCompatibilityRunner(() => textModel('healed'));

  const result = await runner.runToCompletion(AGENT, 'heal this');

  expect(result.finalOutput).toBe('healed');
  expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
});

it('run returns an unsettled stream, so finalOutput is not readable yet', async () => {
  const runner = createApplicationCompatibilityRunner(() => textModel('healed'));

  const stream = await runner.run(AGENT as any, 'heal this');

  expect(stream.finalOutput).toBeUndefined();
  await stream.completed;
  expect(stream.finalOutput).toBe('healed');
});

it('runToCompletion enforces the run options turn budget', async () => {
  const toolCallingModel: StreamedModelTurn = {
    async *stream() {
      yield { type: 'tool_call', id: 'call-1', name: 'again', arguments: '{}' };
      yield { type: 'completion', responseId: 'resp-1', output: [] };
    },
  };
  const agent = {
    ...AGENT,
    tools: [
      {
        name: 'again',
        description: 'Always callable',
        parameters: z.object({}),
        needsApproval: () => false,
        execute: () => 'ok',
        formatCommandMessage: () => [],
      },
    ],
  };
  const runner = createApplicationCompatibilityRunner(() => toolCallingModel);

  await expect(runner.runToCompletion(agent, 'go', { maxTurns: 2 })).rejects.toThrow(/Max turns \(2\) exceeded/);
});

it('settleProviderRun settles a runner that only exposes the live-stream run', async () => {
  const compat = createApplicationCompatibilityRunner(() => textModel('healed'));
  const liveOnlyRunner = { config: compat.config, run: compat.run.bind(compat) };

  const result = await settleProviderRun(liveOnlyRunner as any, AGENT, 'heal this');

  expect(result.finalOutput).toBe('healed');
});

it('openai provider is registered', () => {
  const provider = getProvider('openai');
  expect(provider).toBeTruthy();
  expect(provider?.id).toBe('openai');
  expect(provider?.label).toBe('OpenAI');
  expect(typeof provider?.fetchModels, 'fetchModels should be a function').toBe('function');
});

it('openrouter provider is registered', () => {
  const provider = getProvider('openrouter');
  expect(provider).toBeTruthy();
  expect(provider?.id).toBe('openrouter');
  expect(provider?.label).toBe('OpenRouter');
  expect(typeof provider?.fetchModels, 'fetchModels should be a function').toBe('function');
});

it('getProvider returns undefined for unknown provider', () => {
  const provider = getProvider('nonexistent');
  expect(provider).toBe(undefined);
});

it('getAllProviders returns array of provider definitions', () => {
  const providers = getAllProviders();
  expect(Array.isArray(providers)).toBe(true);
  expect(providers.length >= 2).toBe(true);

  const ids = providers.map((p) => p.id);
  expect(ids.includes('openai')).toBe(true);
  expect(ids.includes('openrouter')).toBe(true);
});

it('getProviderIds returns array of provider IDs', () => {
  const ids = getProviderIds();
  expect(Array.isArray(ids)).toBe(true);
  expect(ids.length >= 2).toBe(true);
  expect(ids.includes('openai')).toBe(true);
  expect(ids.includes('openrouter')).toBe(true);
});

it('provider definitions have required properties', () => {
  const providers = getAllProviders();

  for (const provider of providers) {
    expect(typeof provider.id, `${provider.id}: id should be string`).toBe('string');
    expect(typeof provider.label, `${provider.id}: label should be string`).toBe('string');
    expect(typeof provider.fetchModels, `${provider.id}: fetchModels should be function`).toBe('function');

    // Optional properties
    if (provider.createRunner !== undefined) {
      expect(typeof provider.createRunner, `${provider.id}: createRunner should be function if defined`).toBe(
        'function',
      );
    }

    if (provider.clearConversations !== undefined) {
      expect(
        typeof provider.clearConversations,
        `${provider.id}: clearConversations should be function if defined`,
      ).toBe('function');
    }

    if (provider.sensitiveSettingKeys !== undefined) {
      expect(Array.isArray(provider.sensitiveSettingKeys)).toBe(true);
    }
  }
});

it('openai provider exposes the application-owned streamed model factory', () => {
  const provider = getProvider('openai');
  expect(typeof provider?.createStreamedModel).toBe('function');
});

it('openai provider exposes capabilities without requiring credentials', () => {
  const provider = getProvider('openai');
  expect(provider?.capabilities).toEqual({
    supportsConversationChaining: true,
    supportsTracingControl: true,
    usesStrictToolSchema: true,
    supportsPromptCacheKey: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
  });
});

it('openrouter provider exposes the application-owned streamed model factory', () => {
  const provider = getProvider('openrouter');
  expect(typeof provider?.createStreamedModel).toBe('function');
});

it('openai provider has sensitiveSettingKeys defined', () => {
  const provider = getProvider('openai');
  expect(provider?.sensitiveSettingKeys).toBeTruthy();
  expect(Array.isArray(provider?.sensitiveSettingKeys)).toBe(true);
  // OpenAI provider currently has an empty array
  expect(provider!.sensitiveSettingKeys!.length).toBe(0);
});

it('openrouter provider has sensitive setting keys', () => {
  const provider = getProvider('openrouter');
  expect(provider?.sensitiveSettingKeys).toBeTruthy();
  expect(Array.isArray(provider?.sensitiveSettingKeys)).toBe(true);
  expect(provider!.sensitiveSettingKeys!.includes('agent.openrouter.apiKey')).toBe(true);
  expect(provider!.sensitiveSettingKeys!.includes('agent.openrouter.baseUrl')).toBe(true);
});

it('sortProvidersByOrder returns original order when providerOrder is empty', () => {
  const ids = ['openai', 'openrouter', 'codex'];
  const result = sortProvidersByOrder(ids, []);
  expect(result).toEqual(['openai', 'openrouter', 'codex']);
});

it('sortProvidersByOrder reorders according to providerOrder', () => {
  const ids = ['openai', 'openrouter', 'codex'];
  const result = sortProvidersByOrder(ids, ['codex', 'openai']);
  expect(result).toEqual(['codex', 'openai', 'openrouter']);
});

it('sortProvidersByOrder appends unknown providers at the end', () => {
  const ids = ['openai', 'openrouter', 'codex'];
  const result = sortProvidersByOrder(ids, ['anthropic', 'codex']);
  expect(result).toEqual(['codex', 'openai', 'openrouter']);
});

it('sortProvidersByOrder ignores providerOrder entries not in the list', () => {
  const ids = ['openai', 'openrouter'];
  const result = sortProvidersByOrder(ids, ['codex', 'openrouter', 'openai']);
  expect(result).toEqual(['openrouter', 'openai']);
});

it('sortProvidersByOrder preserves relative order of unordered providers', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const result = sortProvidersByOrder(ids, ['c', 'a']);
  expect(result).toEqual(['c', 'a', 'b', 'd']);
});
