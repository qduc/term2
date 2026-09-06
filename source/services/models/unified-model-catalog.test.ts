import { expect, it } from 'vitest';
import { filterUnifiedModels, mergeUnifiedModels } from './unified-model-catalog.js';

it('pins favorites, enriches them from catalogs, and removes duplicate rows', () => {
  const catalogs = new Map([
    ['one', [{ id: 'alpha', name: 'Alpha', provider: 'one' }]],
    ['two', [{ id: 'beta', provider: 'two' }]],
  ]);

  expect(mergeUnifiedModels(['one', 'two'], catalogs, [{ id: 'beta', provider: 'two' }])).toEqual([
    { id: 'beta', provider: 'two' },
    { id: 'alpha', name: 'Alpha', provider: 'one' },
  ]);
});

it('filters by provider and model together', () => {
  const models = [
    { id: 'shared-model', provider: 'one' },
    { id: 'shared-model', provider: 'two' },
  ];

  expect(filterUnifiedModels(models, 'shared', 'two')).toEqual([{ id: 'shared-model', provider: 'two' }]);
});

it('matches a provider directly in the global search query', () => {
  const models = [
    { id: 'alpha', provider: 'one' },
    { id: 'beta', provider: 'two' },
  ];

  expect(filterUnifiedModels(models, 'two')).toEqual([{ id: 'beta', provider: 'two' }]);
  expect(filterUnifiedModels(models, 'two/beta')).toEqual([{ id: 'beta', provider: 'two' }]);
});
