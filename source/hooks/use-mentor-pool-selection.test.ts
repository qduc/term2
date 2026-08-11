import { expect, it } from 'vitest';
import { mergeMentorPoolModels, resolveMentorPoolModelSelection } from './use-mentor-pool-selection.js';

it('offers saved pool IDs and the current draft value when they are absent from the provider catalog', () => {
  const models = mergeMentorPoolModels({
    catalogModels: [{ id: 'catalog-model', provider: 'openai' }],
    entries: [
      { model: 'saved-model', provider: 'openai' },
      { model: 'other-provider-model', provider: 'openrouter' },
      { model: 'inherited-model' },
    ],
    provider: 'openai',
    currentModel: 'custom-current-model',
  });

  expect(models.map((model) => model.id)).toEqual([
    'custom-current-model',
    'saved-model',
    'inherited-model',
    'catalog-model',
  ]);
  expect(models[0]).toMatchObject({ name: 'Current model (not in catalog)', provider: 'openai' });
  expect(models[1]).toMatchObject({ name: 'In mentor pool', provider: 'openai' });
});

it('keeps catalog metadata when a saved pool model is already known to the provider', () => {
  const models = mergeMentorPoolModels({
    catalogModels: [{ id: 'known-model', name: 'Known Model', provider: 'openai' }],
    entries: [{ model: 'known-model', provider: 'openai' }],
    provider: 'openai',
    currentModel: 'known-model',
  });

  expect(models).toEqual([{ id: 'known-model', name: 'Known Model', provider: 'openai' }]);
});

it('selects the highlighted catalog model but accepts a typed custom ID when there is no match', () => {
  const models = [{ id: 'catalog-model', provider: 'openai' }];

  expect(resolveMentorPoolModelSelection(models, 0, 'custom-model')).toBe('catalog-model');
  expect(resolveMentorPoolModelSelection([], 0, ' custom-model ')).toBe('custom-model');
});
