import test from 'ava';
import { parseModelProviderArg } from './model-provider-arg.js';

test('parseModelProviderArg returns model when provider flag is absent', (t) => {
  t.deepEqual(parseModelProviderArg('gpt-4o'), {
    modelId: 'gpt-4o',
    provider: undefined,
  });
});

test('parseModelProviderArg parses provider with spaces', (t) => {
  t.deepEqual(parseModelProviderArg('deepseek-v4-flash --provider=opencode go'), {
    modelId: 'deepseek-v4-flash',
    provider: 'opencode go',
  });
});

test('parseModelProviderArg trims surrounding whitespace', (t) => {
  t.deepEqual(parseModelProviderArg('  gpt-4o-mini   --provider=openrouter   '), {
    modelId: 'gpt-4o-mini',
    provider: 'openrouter',
  });
});
