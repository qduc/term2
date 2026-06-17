import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { parseModelProviderArg } from './model-provider-arg.js';

it('parseModelProviderArg returns model when provider flag is absent', () => {
  expect(parseModelProviderArg('gpt-4o')).toEqual({
    modelId: 'gpt-4o',
    provider: undefined,
  });
});

it('parseModelProviderArg parses provider with spaces', () => {
  expect(parseModelProviderArg('deepseek-v4-flash --provider=opencode go')).toEqual({
    modelId: 'deepseek-v4-flash',
    provider: 'opencode go',
  });
});

it('parseModelProviderArg trims surrounding whitespace', () => {
  expect(parseModelProviderArg('  gpt-4o-mini   --provider=openrouter   ')).toEqual({
    modelId: 'gpt-4o-mini',
    provider: 'openrouter',
  });
});
