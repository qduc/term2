import { describe, expect, it } from 'vitest';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import { FAVORITES_TAB_ID } from './model-favorites.js';
import {
  NICKNAME_MAX_LENGTH,
  findNicknameMatch,
  getNicknameEntries,
  getNicknameLabels,
  parseNicknameTargetEntry,
  serializeNicknameTarget,
  setNicknameTarget,
  validateNicknameName,
} from './model-nicknames.js';

describe('parseNicknameTargetEntry', () => {
  it('parses a plain "provider/modelId" target by splitting on the FIRST slash', () => {
    expect(parseNicknameTargetEntry('openai/gpt-5.4')).toEqual({ provider: 'openai', modelId: 'gpt-5.4' });
  });

  it('parses a target whose model id itself contains a slash', () => {
    expect(parseNicknameTargetEntry('openrouter/anthropic/claude-3.5-sonnet')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-3.5-sonnet',
    });
  });

  it('splits a stored reasoning-effort suffix off the target', () => {
    expect(parseNicknameTargetEntry('openai/gpt-5.4:high')).toEqual({
      provider: 'openai',
      modelId: 'gpt-5.4',
      reasoningEffort: 'high',
    });
  });

  it('splits the effort suffix after a slash-containing model id', () => {
    expect(parseNicknameTargetEntry('openrouter/anthropic/claude-3.5-sonnet:low')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-3.5-sonnet',
      reasoningEffort: 'low',
    });
  });

  it('keeps a non-effort colon suffix as part of the model id (same rule as --model parsing)', () => {
    expect(parseNicknameTargetEntry('openai/foo:batch')).toEqual({ provider: 'openai', modelId: 'foo:batch' });
  });

  it('returns null for targets with no separator, an empty provider, or an empty model id', () => {
    expect(parseNicknameTargetEntry('not-a-target')).toBeNull();
    expect(parseNicknameTargetEntry('/gpt-5.4')).toBeNull();
    expect(parseNicknameTargetEntry('openai/')).toBeNull();
  });
});

describe('serializeNicknameTarget', () => {
  it('round-trips provider, model id, and optional effort suffix', () => {
    const roundTrip = (raw: string) => {
      const parsed = parseNicknameTargetEntry(raw);
      return parsed ? serializeNicknameTarget(parsed) : null;
    };
    expect(roundTrip('openai/gpt-5.4')).toBe('openai/gpt-5.4');
    expect(roundTrip('openai/gpt-5.4:high')).toBe('openai/gpt-5.4:high');
    expect(roundTrip('openrouter/anthropic/claude-3.5-sonnet:low')).toBe('openrouter/anthropic/claude-3.5-sonnet:low');
  });
});

describe('getNicknameEntries', () => {
  it('returns an empty list when no nicknames are set', () => {
    expect(getNicknameEntries(createMockSettingsService())).toEqual([]);
  });

  it('parses persisted entries in order', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { op: 'openai/gpt-5.4', sonnet: 'anthropic/claude-sonnet-4:high' },
    });
    expect(getNicknameEntries(settingsService)).toEqual([
      { nickname: 'op', provider: 'openai', modelId: 'gpt-5.4' },
      { nickname: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-4', reasoningEffort: 'high' },
    ]);
  });

  it('silently drops entries with malformed targets instead of crashing resolution or the picker', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { op: 'openai/gpt-5.4', bad: 'no-separator' },
    });
    expect(getNicknameEntries(settingsService)).toEqual([{ nickname: 'op', provider: 'openai', modelId: 'gpt-5.4' }]);
  });

  it('silently drops entries whose name is not a valid nickname', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { 'has spaces': 'openai/gpt-5.4', 'ok-name': 'openai/gpt-5.4' },
    });
    expect(getNicknameEntries(settingsService)).toEqual([
      { nickname: 'ok-name', provider: 'openai', modelId: 'gpt-5.4' },
    ]);
  });

  it('keeps only the first of case-insensitive duplicate names so a match stays unambiguous', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { Op: 'openai/model-a', OP: 'anthropic/model-b' },
    });
    expect(getNicknameEntries(settingsService)).toEqual([{ nickname: 'Op', provider: 'openai', modelId: 'model-a' }]);
  });

  it('degrades to empty when the stored value is not an object (hand-edited settings file)', () => {
    const settingsService = createMockSettingsService({ 'agent.modelNicknames': 'oops' as any });
    expect(getNicknameEntries(settingsService)).toEqual([]);
  });
});

describe('getNicknameLabels', () => {
  it('maps the serialized model identity to its nickname for row rendering', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { op: 'openrouter/anthropic/claude-3.5-sonnet' },
    });
    expect(getNicknameLabels(settingsService).get('openrouter/anthropic/claude-3.5-sonnet')).toBe('op');
  });
});

describe('validateNicknameName', () => {
  it('accepts plain identifier-shaped names', () => {
    expect(validateNicknameName('op')).toEqual({ ok: true, nickname: 'op' });
    expect(validateNicknameName('Op_2-x')).toEqual({ ok: true, nickname: 'Op_2-x' });
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(validateNicknameName('').ok).toBe(false);
    expect(validateNicknameName('   ').ok).toBe(false);
  });

  it('rejects characters that are unsafe or ambiguous as a CLI value', () => {
    for (const bad of ['has space', 'a/b', 'a:b', 'a*b', 'a$b', 'a;b', 'a|b', 'a&b', 'a"b', "a'b", 'a{b']) {
      expect(validateNicknameName(bad).ok, bad).toBe(false);
    }
  });

  it('rejects a leading hyphen or underscore (a leading - would parse as a CLI flag)', () => {
    expect(validateNicknameName('-op').ok).toBe(false);
    expect(validateNicknameName('_op').ok).toBe(false);
  });

  it('rejects the reserved Favorites pseudo-provider sentinel', () => {
    expect(validateNicknameName(FAVORITES_TAB_ID).ok).toBe(false);
  });

  it('rejects a name that collides with a provider id, case-insensitively', () => {
    const result = validateNicknameName('OpenAI', { providerIds: ['openai', 'anthropic'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('provider name');
  });

  it('rejects a duplicate of an existing nickname, case-insensitively', () => {
    const result = validateNicknameName('OP', { existingNicknames: ['op'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('already in use');
  });

  it('enforces a maximum length', () => {
    expect(validateNicknameName('a'.repeat(NICKNAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateNicknameName('a'.repeat(NICKNAME_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('setNicknameTarget', () => {
  it('persists a valid new nickname as nickname -> "provider/modelId"', () => {
    const settingsService = createMockSettingsService();
    const result = setNicknameTarget(settingsService, 'op', { provider: 'openai', modelId: 'gpt-5.4' });
    expect(result).toEqual({ ok: true });
    expect(settingsService.get('agent.modelNicknames')).toEqual({ op: 'openai/gpt-5.4' });
  });

  it('persists a stored reasoning-effort suffix on the target', () => {
    const settingsService = createMockSettingsService();
    setNicknameTarget(settingsService, 'op', { provider: 'openai', modelId: 'gpt-5.4', reasoningEffort: 'high' });
    expect(settingsService.get('agent.modelNicknames')).toEqual({ op: 'openai/gpt-5.4:high' });
  });

  it('round-trips a model id that itself contains slashes', () => {
    const settingsService = createMockSettingsService();
    setNicknameTarget(settingsService, 'sonnet', {
      provider: 'openrouter',
      modelId: 'anthropic/claude-3.5-sonnet',
    });
    expect(settingsService.get('agent.modelNicknames')).toEqual({
      sonnet: 'openrouter/anthropic/claude-3.5-sonnet',
    });
  });

  it('rejects an invalid name without writing anything', () => {
    const settingsService = createMockSettingsService();
    const result = setNicknameTarget(settingsService, 'bad name', { provider: 'openai', modelId: 'gpt-5.4' });
    expect(result.ok).toBe(false);
    expect(settingsService.get('agent.modelNicknames')).toEqual({});
  });

  it('rejects a name that duplicates a different nickname without writing anything', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { op: 'openai/gpt-5.4' },
    });
    const result = setNicknameTarget(settingsService, 'OP', { provider: 'anthropic', modelId: 'claude-sonnet-4' });
    expect(result.ok).toBe(false);
    expect(settingsService.get('agent.modelNicknames')).toEqual({ op: 'openai/gpt-5.4' });
  });

  it('rejects a name that collides with a provider id when provider ids are supplied', () => {
    const settingsService = createMockSettingsService();
    const result = setNicknameTarget(
      settingsService,
      'openai',
      { provider: 'openai', modelId: 'gpt-5.4' },
      { providerIds: ['openai'] },
    );
    expect(result.ok).toBe(false);
    expect(settingsService.get('agent.modelNicknames')).toEqual({});
  });

  it('renames an existing nickname for the same target, removing the old key', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { op: 'openai/gpt-5.4', other: 'anthropic/claude-sonnet-4' },
    });
    const result = setNicknameTarget(settingsService, 'opus', { provider: 'openai', modelId: 'gpt-5.4' });
    expect(result).toEqual({ ok: true });
    expect(settingsService.get('agent.modelNicknames')).toEqual({
      opus: 'openai/gpt-5.4',
      other: 'anthropic/claude-sonnet-4',
    });
  });

  it('rejects re-pointing a live name at a different target (no silent nickname stealing)', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { op: 'openai/gpt-5.4', other: 'anthropic/claude-sonnet-4' },
    });
    const result = setNicknameTarget(settingsService, 'op', { provider: 'anthropic', modelId: 'claude-opus-4' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('already in use');
    expect(settingsService.get('agent.modelNicknames')).toEqual({
      op: 'openai/gpt-5.4',
      other: 'anthropic/claude-sonnet-4',
    });
  });

  it('rejects a case-variant of a live name pointed at a different target', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { op: 'openai/gpt-5.4' },
    });
    const result = setNicknameTarget(settingsService, 'OP', { provider: 'anthropic', modelId: 'claude-opus-4' });
    expect(result.ok).toBe(false);
    expect(settingsService.get('agent.modelNicknames')).toEqual({ op: 'openai/gpt-5.4' });
  });

  it('accepts a case-variant rewrite when the target is unchanged', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { op: 'openai/gpt-5.4' },
    });
    const result = setNicknameTarget(settingsService, 'OP', { provider: 'openai', modelId: 'gpt-5.4' });
    expect(result).toEqual({ ok: true });
    expect(settingsService.get('agent.modelNicknames')).toEqual({ OP: 'openai/gpt-5.4' });
  });

  it('is a no-op when the same name already maps to the same target', () => {
    const settingsService = createMockSettingsService({
      'agent.modelNicknames': { op: 'openai/gpt-5.4' },
    });
    const result = setNicknameTarget(settingsService, 'op', { provider: 'openai', modelId: 'gpt-5.4' });
    expect(result).toEqual({ ok: true });
    expect(settingsService.get('agent.modelNicknames')).toEqual({ op: 'openai/gpt-5.4' });
  });
});

describe('findNicknameMatch', () => {
  const settingsService = () =>
    createMockSettingsService({
      'agent.modelNicknames': { op: 'anthropic/claude-opus-4' },
    });

  it('matches a nickname exactly and case-insensitively', () => {
    expect(findNicknameMatch(settingsService(), 'op')).toEqual({
      nickname: 'op',
      provider: 'anthropic',
      modelId: 'claude-opus-4',
    });
    expect(findNicknameMatch(settingsService(), 'OP')).toEqual({
      nickname: 'op',
      provider: 'anthropic',
      modelId: 'claude-opus-4',
    });
  });

  it('returns undefined for a non-exact pattern (nicknames are exact-only)', () => {
    expect(findNicknameMatch(settingsService(), 'ops')).toBeUndefined();
    expect(findNicknameMatch(settingsService(), 'o')).toBeUndefined();
  });

  it('returns undefined for an empty pattern', () => {
    expect(findNicknameMatch(settingsService(), '')).toBeUndefined();
  });

  it('is scoped out when the parsed provider does not match the target provider', () => {
    expect(findNicknameMatch(settingsService(), 'op', { providerScope: 'openai' })).toBeUndefined();
  });

  it('stays eligible when the parsed provider matches the target provider', () => {
    expect(findNicknameMatch(settingsService(), 'op', { providerScope: 'anthropic' })).toEqual({
      nickname: 'op',
      provider: 'anthropic',
      modelId: 'claude-opus-4',
    });
  });

  it('excludes a hand-edited nickname equal to a registered provider id', () => {
    const hijack = createMockSettingsService({
      'agent.modelNicknames': { openai: 'anthropic/claude-opus-4' },
    });
    expect(findNicknameMatch(hijack, 'openai', { knownProviders: ['openai', 'anthropic'] })).toBeUndefined();
  });
});
