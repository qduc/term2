import { describe, expect, it } from 'vitest';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import {
  FAVORITES_TAB_ID,
  getFavoriteEntries,
  getFavoriteModelInfos,
  isFavoriteModel,
  parseFavoriteEntry,
  serializeFavorite,
  toggleFavoriteModel,
} from './model-favorites.js';

describe('serializeFavorite / parseFavoriteEntry round-trip', () => {
  it('round-trips a plain provider and model id', () => {
    const entry = serializeFavorite('openai', 'gpt-5.4');
    expect(entry).toBe('openai/gpt-5.4');
    expect(parseFavoriteEntry(entry)).toEqual({ provider: 'openai', modelId: 'gpt-5.4' });
  });

  it('round-trips a model id that itself contains a slash (e.g. an OpenRouter vendor-qualified id)', () => {
    const entry = serializeFavorite('openrouter', 'anthropic/claude-3.5-sonnet');
    expect(entry).toBe('openrouter/anthropic/claude-3.5-sonnet');
    // Splitting on the FIRST '/' is required: the provider id never contains
    // one (enforced by PROVIDER_NAME_REGEX at provider-creation time), but a
    // model id can. Splitting on the last '/' would wrongly read the
    // provider as "openrouter/anthropic".
    expect(parseFavoriteEntry(entry)).toEqual({ provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' });
  });

  it('round-trips a model id with multiple embedded slashes', () => {
    const entry = serializeFavorite('openrouter', 'meta/llama/3.1-405b');
    expect(parseFavoriteEntry(entry)).toEqual({ provider: 'openrouter', modelId: 'meta/llama/3.1-405b' });
  });

  it('returns null for an entry with no separator', () => {
    expect(parseFavoriteEntry('not-a-favorite')).toBeNull();
  });

  it('returns null for an entry with an empty provider', () => {
    expect(parseFavoriteEntry('/gpt-5.4')).toBeNull();
  });

  it('returns null for an entry with an empty model id', () => {
    expect(parseFavoriteEntry('openai/')).toBeNull();
  });
});

describe('getFavoriteEntries / getFavoriteModelInfos', () => {
  it('returns an empty list when nothing is favorited', () => {
    const settingsService = createMockSettingsService();
    expect(getFavoriteEntries(settingsService)).toEqual([]);
    expect(getFavoriteModelInfos(settingsService)).toEqual([]);
  });

  it('parses persisted entries in order, exposing id + home provider only', () => {
    const settingsService = createMockSettingsService({
      'agent.favoriteModels': ['openai/gpt-5.4', 'openrouter/anthropic/claude-3.5-sonnet'],
    });
    expect(getFavoriteEntries(settingsService)).toEqual([
      { provider: 'openai', modelId: 'gpt-5.4' },
      { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' },
    ]);
    expect(getFavoriteModelInfos(settingsService)).toEqual([
      { id: 'gpt-5.4', provider: 'openai' },
      { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter' },
    ]);
  });

  it('silently drops a string entry with no separator instead of throwing', () => {
    // The schema (z.array(z.string())) guarantees every persisted entry is a
    // string, but not that it round-trips through parseFavoriteEntry (e.g. a
    // hand-edited settings.json). getFavoriteEntries must degrade instead of
    // crashing resolution or the picker.
    const settingsService = createMockSettingsService({
      'agent.favoriteModels': ['openai/gpt-5.4', 'malformed-entry'],
    });
    expect(getFavoriteEntries(settingsService)).toEqual([{ provider: 'openai', modelId: 'gpt-5.4' }]);
  });
});

describe('isFavoriteModel', () => {
  it('matches provider case-insensitively and model id exactly', () => {
    const settingsService = createMockSettingsService({
      'agent.favoriteModels': ['OpenAI/gpt-5.4'],
    });
    expect(isFavoriteModel(settingsService, 'openai', 'gpt-5.4')).toBe(true);
    expect(isFavoriteModel(settingsService, 'openai', 'gpt-5.4-mini')).toBe(false);
    expect(isFavoriteModel(settingsService, 'anthropic', 'gpt-5.4')).toBe(false);
  });
});

describe('toggleFavoriteModel', () => {
  it('adds a model that is not yet favorited and persists it', () => {
    const settingsService = createMockSettingsService();
    const result = toggleFavoriteModel(settingsService, 'openai', 'gpt-5.4');
    expect(result).toBe(true);
    expect(settingsService.get('agent.favoriteModels')).toEqual(['openai/gpt-5.4']);
  });

  it('removes a model that is already favorited and persists the removal', () => {
    const settingsService = createMockSettingsService({
      'agent.favoriteModels': ['openai/gpt-5.4', 'anthropic/claude-sonnet-4'],
    });
    const result = toggleFavoriteModel(settingsService, 'openai', 'gpt-5.4');
    expect(result).toBe(false);
    expect(settingsService.get('agent.favoriteModels')).toEqual(['anthropic/claude-sonnet-4']);
  });

  it('preserves a model id containing slashes across add and remove', () => {
    const settingsService = createMockSettingsService();
    toggleFavoriteModel(settingsService, 'openrouter', 'anthropic/claude-3.5-sonnet');
    expect(settingsService.get('agent.favoriteModels')).toEqual(['openrouter/anthropic/claude-3.5-sonnet']);
    expect(isFavoriteModel(settingsService, 'openrouter', 'anthropic/claude-3.5-sonnet')).toBe(true);

    const result = toggleFavoriteModel(settingsService, 'openrouter', 'anthropic/claude-3.5-sonnet');
    expect(result).toBe(false);
    expect(settingsService.get('agent.favoriteModels')).toEqual([]);
  });

  it('does not disturb favorites for other providers with the same model id', () => {
    const settingsService = createMockSettingsService({
      'agent.favoriteModels': ['openai/shared-id'],
    });
    toggleFavoriteModel(settingsService, 'anthropic', 'shared-id');
    expect(settingsService.get('agent.favoriteModels')).toEqual(['openai/shared-id', 'anthropic/shared-id']);
  });
});

describe('FAVORITES_TAB_ID', () => {
  it('cannot collide with a real provider id (which must match PROVIDER_NAME_REGEX)', () => {
    // PROVIDER_NAME_REGEX forbids leading underscores, so no user-created
    // provider can ever equal this sentinel.
    expect(FAVORITES_TAB_ID.startsWith('_')).toBe(true);
  });
});
