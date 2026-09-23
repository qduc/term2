import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../model-service.js';
import { nextModelTab, pinnedModelsForTab, selectModelsForTab } from './model-tabs.js';

const favorite: ModelInfo = { id: 'fav', provider: 'openai' };
const named: ModelInfo = { id: 'named', provider: 'openai' };
const plain: ModelInfo = { id: 'plain', provider: 'openai' };
const models = [favorite, named, plain];
const keys = {
  favoriteKeys: new Set(['openai/fav']),
  nicknameKeys: new Set(['openai/named']),
};

describe('nextModelTab', () => {
  it('advances Favorites, then Nicknames, then All, then wraps', () => {
    expect(nextModelTab('favorites')).toBe('nicknames');
    expect(nextModelTab('nicknames')).toBe('all');
    expect(nextModelTab('all')).toBe('favorites');
  });
});

describe('pinnedModelsForTab', () => {
  it('pins nickname targets only on the Nicknames tab', () => {
    expect(pinnedModelsForTab('all', [favorite], [named])).toEqual([favorite]);
    expect(pinnedModelsForTab('favorites', [favorite], [named])).toEqual([favorite]);
    expect(pinnedModelsForTab('nicknames', [favorite], [named])).toEqual([favorite, named]);
  });
});

describe('selectModelsForTab', () => {
  it('keeps every model on All', () => {
    expect(selectModelsForTab(models, 'all', keys)).toEqual(models);
  });

  it('keeps only favorited models on Favorites', () => {
    expect(selectModelsForTab(models, 'favorites', keys)).toEqual([favorite]);
  });

  it('keeps only nicknamed models on Nicknames', () => {
    expect(selectModelsForTab(models, 'nicknames', keys)).toEqual([named]);
  });
});
