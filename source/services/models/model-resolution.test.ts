import { describe, expect, it, vi } from 'vitest';
import { registerProvider, unregisterProvider } from '../../providers/registry.js';
import type { ModelInfo } from '../model-service.js';
import type { ProviderModelGroup } from './model-listing.js';
import {
  formatDisambiguationPrompt,
  matchModels,
  parseModelFlag,
  promptForDisambiguation,
  resolveModelFlag,
  type ModelResolutionResult,
} from './model-resolution.js';

const makeGroup = (
  provider: string,
  models: Array<{ id: string; name?: string }>,
  options?: { label?: string; error?: string },
): ProviderModelGroup => ({
  provider,
  label: options?.label,
  error: options?.error,
  models: models.map((m) => ({ id: m.id, name: m.name, provider })),
});

const mockDeps = (
  groups: ProviderModelGroup[],
  options?: {
    getSetting?: (key: string) => any;
  },
) => ({
  settingsService: {
    get: vi.fn((key: string) => options?.getSetting?.(key) ?? (key === 'agent.provider' ? 'openai' : undefined)),
    getDynamic: vi.fn(() => []),
  } as any,
  loggingService: { warn: vi.fn() } as any,
  fetcher: vi.fn(async (provider: string) => {
    const group = groups.find((g) => g.provider === provider);
    if (group?.error) throw new Error(group.error);
    return group?.models ?? [];
  }),
  providerIds: groups.map((g) => g.provider),
});

describe('parseModelFlag', () => {
  const knownProviders = ['openai', 'anthropic', 'openrouter', 'google'];

  it('parses bare model pattern without thinking or provider', () => {
    const result = parseModelFlag('gpt-5.4', { knownProviders });
    expect(result).toEqual({
      pattern: 'gpt-5.4',
      rawPattern: 'gpt-5.4',
      provider: undefined,
      reasoningEffort: undefined,
    });
  });

  it('extracts valid thinking suffix (:high, :low, etc.)', () => {
    expect(parseModelFlag('gpt-5.4:high', { knownProviders })).toEqual({
      pattern: 'gpt-5.4',
      rawPattern: 'gpt-5.4',
      provider: undefined,
      reasoningEffort: 'high',
    });

    expect(parseModelFlag('claude-sonnet:low', { knownProviders })).toEqual({
      pattern: 'claude-sonnet',
      rawPattern: 'claude-sonnet',
      provider: undefined,
      reasoningEffort: 'low',
    });

    expect(parseModelFlag('deepseek:medium', { knownProviders })).toEqual({
      pattern: 'deepseek',
      rawPattern: 'deepseek',
      provider: undefined,
      reasoningEffort: 'medium',
    });
  });

  it('does not strip non-reasoning colon suffix (e.g. :batch)', () => {
    const result = parseModelFlag('claude-opus:batch', { knownProviders });
    expect(result).toEqual({
      pattern: 'claude-opus:batch',
      rawPattern: 'claude-opus:batch',
      provider: undefined,
      reasoningEffort: undefined,
    });
  });

  it('extracts known provider prefix (e.g. openai/gpt-5.4)', () => {
    const result = parseModelFlag('openai/gpt-5.4', { knownProviders });
    expect(result).toEqual({
      pattern: 'gpt-5.4',
      rawPattern: 'openai/gpt-5.4',
      provider: 'openai',
      reasoningEffort: undefined,
    });
  });

  it('extracts provider prefix and thinking suffix together', () => {
    const result = parseModelFlag('openai/gpt-5.4:high', { knownProviders });
    expect(result).toEqual({
      pattern: 'gpt-5.4',
      rawPattern: 'openai/gpt-5.4',
      provider: 'openai',
      reasoningEffort: 'high',
    });
  });

  it('does not treat unknown prefix as provider (e.g. meta-llama/llama-3)', () => {
    const result = parseModelFlag('meta-llama/llama-3', { knownProviders });
    expect(result).toEqual({
      pattern: 'meta-llama/llama-3',
      rawPattern: 'meta-llama/llama-3',
      provider: undefined,
      reasoningEffort: undefined,
    });
  });

  it('uses explicit providerFlag when supplied', () => {
    const result = parseModelFlag('anthropic/claude-3.5-sonnet:medium', {
      providerFlag: 'openrouter',
      knownProviders,
    });
    expect(result).toEqual({
      pattern: 'anthropic/claude-3.5-sonnet',
      rawPattern: 'anthropic/claude-3.5-sonnet',
      provider: 'openrouter',
      reasoningEffort: 'medium',
    });
  });
});

describe('matchModels', () => {
  const groups: ProviderModelGroup[] = [
    makeGroup(
      'openai',
      [
        { id: 'gpt-5.4', name: 'GPT 5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini' },
        { id: 'gpt-5.4-nano', name: 'GPT 5.4 Nano' },
        { id: 'gpt-4o' },
      ],
      { label: 'OpenAI' },
    ),
    makeGroup(
      'anthropic',
      [
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
        { id: 'claude-opus-4', name: 'Claude Opus 4' },
      ],
      { label: 'Anthropic' },
    ),
    makeGroup(
      'openrouter',
      [{ id: 'gpt-4o' }, { id: 'anthropic/claude-3.5-sonnet' }, { id: 'meta-llama/llama-3-70b-instruct' }],
      { label: 'OpenRouter' },
    ),
  ];

  it('returns single exact match without fuzzy matches when exact match exists', () => {
    const parsed = parseModelFlag('gpt-5.4');
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].provider).toBe('openai');
    expect(result.matches[0].model.id).toBe('gpt-5.4');
  });

  it('returns multiple exact matches when identical model id exists across providers', () => {
    const parsed = parseModelFlag('gpt-4o');
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((m) => m.provider)).toEqual(['openai', 'openrouter']);
  });

  it('returns exact match for provider-scoped query', () => {
    const parsed = parseModelFlag('openai/gpt-4o', { knownProviders: ['openai', 'openrouter'] });
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].provider).toBe('openai');
    expect(result.matches[0].model.id).toBe('gpt-4o');
  });

  it('returns exact match when full rawPattern matches a slash model id (e.g. openrouter)', () => {
    const parsed = parseModelFlag('anthropic/claude-3.5-sonnet', { knownProviders: ['anthropic', 'openrouter'] });
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].provider).toBe('openrouter');
    expect(result.matches[0].model.id).toBe('anthropic/claude-3.5-sonnet');
  });

  it('prefers the id exactly as typed over the split provider+pattern reading', () => {
    // `openai/gpt-5.4` is a literal id on openrouter AND splits into provider
    // `openai` + pattern `gpt-5.4` which is an exact openai id. The as-typed
    // id must win so bare `-m vendor/model` keeps its pre-fuzzing meaning.
    const conflictingGroups: ProviderModelGroup[] = [
      makeGroup('openai', [{ id: 'gpt-5.4' }]),
      makeGroup('openrouter', [{ id: 'openai/gpt-5.4' }]),
    ];
    const parsed = parseModelFlag('openai/gpt-5.4', { knownProviders: ['openai', 'openrouter'] });
    const result = matchModels(conflictingGroups, parsed);
    expect(result.exact).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].provider).toBe('openrouter');
    expect(result.matches[0].model.id).toBe('openai/gpt-5.4');
  });

  it('falls back to fuzzy matching when no exact match exists', () => {
    const parsed = parseModelFlag('5.4');
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(false);
    expect(result.matches.map((m) => m.model.id)).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']);
  });

  it('fuzzy matches across multiple providers when unconstrained, ranked deterministically', () => {
    // All three candidates match "sonnet" right after a `-` boundary (same
    // tier), so the ranking falls back to scoreSubsequence: the shorter id
    // `claude-sonnet-4` pays a smaller length penalty than the longer
    // `claude-3-5-sonnet-20241022` and the openrouter aggregator id, so it
    // ranks first. This replaces the old raw provider-iteration order.
    const parsed = parseModelFlag('sonnet');
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(false);
    expect(result.matches.map((m) => `${m.provider}/${m.model.id}`)).toEqual([
      'anthropic/claude-sonnet-4',
      'anthropic/claude-3-5-sonnet-20241022',
      'openrouter/anthropic/claude-3.5-sonnet',
    ]);
  });

  it('fuzzy matches constrained to provider when provider is specified, ranked deterministically', () => {
    // Same tier/score ranking as the unconstrained case above, just narrowed
    // to the anthropic group.
    const parsed = parseModelFlag('anthropic/sonnet', { knownProviders: ['anthropic'] });
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(false);
    expect(result.matches.map((m) => `${m.provider}/${m.model.id}`)).toEqual([
      'anthropic/claude-sonnet-4',
      'anthropic/claude-3-5-sonnet-20241022',
    ]);
  });

  it('ranks fuzzy matches by tier (id-prefix > word-boundary > subsequence) then provider order, not catalog order', () => {
    // Deliberately listed worst-to-best in the fixture, and with the best
    // match on the LAST provider, so a passing test proves real ranking
    // rather than incidentally matching iteration order.
    const tierGroups: ProviderModelGroup[] = [
      makeGroup('providerA', [{ id: 'xclaudey' }]), // mid-word subsequence, no boundary before "claude"
      makeGroup('providerB', [{ id: 'foo-claude-y' }]), // word-boundary: "claude" right after "-"
      makeGroup('providerC', [{ id: 'claude-x' }]), // id-prefix: id starts with "claude"
    ];
    const parsed = parseModelFlag('claude');
    const result = matchModels(tierGroups, parsed);
    expect(result.exact).toBe(false);
    expect(result.matches.map((m) => m.model.id)).toEqual(['claude-x', 'foo-claude-y', 'xclaudey']);
  });

  it('tie-breaks equal tier and score by provider order (catalog array order)', () => {
    const tieGroups: ProviderModelGroup[] = [
      makeGroup('zprovider', [{ id: 'claude-x' }]),
      makeGroup('aprovider', [{ id: 'claude-y' }]),
    ];
    const parsed = parseModelFlag('claude');
    const result = matchModels(tieGroups, parsed);
    expect(result.exact).toBe(false);
    // Same tier (id-prefix) and same score (ids differ only in trailing
    // letter, so scoreSubsequence is identical): the earlier provider in the
    // catalog array wins, not alphabetical or any other incidental order.
    expect(result.matches.map((m) => m.provider)).toEqual(['zprovider', 'aprovider']);
  });

  it('returns empty matches when query matches nothing', () => {
    const parsed = parseModelFlag('non-existent-xyz');
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(false);
    expect(result.matches).toHaveLength(0);
  });
});

describe('formatDisambiguationPrompt', () => {
  it('formats numbered list grouped by provider with labels', () => {
    const matches: Array<{ provider: string; model: ModelInfo }> = [
      { provider: 'openai', model: { id: 'gpt-5.4', name: 'GPT 5.4', provider: 'openai' } },
      { provider: 'openai', model: { id: 'gpt-5.4-mini', provider: 'openai' } },
      { provider: 'anthropic', model: { id: 'claude-sonnet-4', name: 'Sonnet 4', provider: 'anthropic' } },
    ];
    const groups: ProviderModelGroup[] = [
      { provider: 'openai', label: 'OpenAI', models: [] },
      { provider: 'anthropic', label: 'Anthropic', models: [] },
    ];

    const formatted = formatDisambiguationPrompt(matches, groups);
    expect(formatted).toBe(
      'openai (OpenAI):\n' +
        '  1) gpt-5.4  GPT 5.4\n' +
        '  2) gpt-5.4-mini\n' +
        'anthropic (Anthropic):\n' +
        '  3) claude-sonnet-4  Sonnet 4',
    );
  });

  it('prompts via stream, re-prompts on invalid input, and returns selected match', async () => {
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = '';
    output.on('data', (chunk) => {
      const text = chunk.toString();
      outputText += text;
      if (text.includes('Please enter a number')) {
        setImmediate(() => input.write('2\n'));
      }
    });

    const matches: Array<{ provider: string; model: ModelInfo }> = [
      { provider: 'openai', model: { id: 'gpt-5.4', provider: 'openai' } },
      { provider: 'openai', model: { id: 'gpt-5.4-mini', provider: 'openai' } },
    ];
    const groups: ProviderModelGroup[] = [{ provider: 'openai', label: 'OpenAI', models: [] }];

    const promise = promptForDisambiguation(matches, groups, 'gpt-5', undefined, { input, output });

    // Send invalid input first
    input.write('invalid\n');

    const result = await promise;
    expect(result).toEqual({ provider: 'openai', model: { id: 'gpt-5.4-mini', provider: 'openai' } });
    expect(outputText).toContain('Multiple models match "gpt-5":');
    expect(outputText).toContain('Please enter a number between 1 and 2.');
  });
});

describe('resolveModelFlag', () => {
  const groups: ProviderModelGroup[] = [
    makeGroup(
      'openai',
      [{ id: 'gpt-5.4', name: 'GPT 5.4' }, { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini' }, { id: 'gpt-4o' }],
      { label: 'OpenAI' },
    ),
    makeGroup('anthropic', [{ id: 'claude-sonnet-4', name: 'Sonnet 4' }], { label: 'Anthropic' }),
  ];

  it('silently resolves single exact match without prompter', async () => {
    const prompter = vi.fn();
    const deps = mockDeps(groups);
    const result = await resolveModelFlag({
      modelFlag: 'gpt-5.4',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      prompter,
      knownProviders: ['openai', 'anthropic'],
    });

    expect(prompter).not.toHaveBeenCalled();
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'gpt-5.4',
      provider: 'openai',
      reasoningEffort: undefined,
    });
  });

  it('silently resolves single fuzzy match without prompter', async () => {
    const prompter = vi.fn();
    const deps = mockDeps(groups);
    const result = await resolveModelFlag({
      modelFlag: 'sonnet',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      prompter,
      knownProviders: ['openai', 'anthropic'],
    });

    expect(prompter).not.toHaveBeenCalled();
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'claude-sonnet-4',
      provider: 'anthropic',
      reasoningEffort: undefined,
    });
  });

  it('preserves thinking suffix on resolved model', async () => {
    const deps = mockDeps(groups);
    const result = await resolveModelFlag({
      modelFlag: 'gpt-5.4:high',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      knownProviders: ['openai', 'anthropic'],
    });

    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'gpt-5.4',
      provider: 'openai',
      reasoningEffort: 'high',
    });
  });

  it('prompts user when multiple matches are found and returns chosen model', async () => {
    const prompter = vi.fn(async () => '2');
    const deps = mockDeps(groups);
    const result = await resolveModelFlag({
      modelFlag: 'gpt-5',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      prompter,
      knownProviders: ['openai', 'anthropic'],
    });

    expect(prompter).toHaveBeenCalledOnce();
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'gpt-5.4-mini',
      provider: 'openai',
      reasoningEffort: undefined,
    });
  });

  it('returns no_match error when query matches nothing', async () => {
    const deps = mockDeps(groups);
    const result = await resolveModelFlag({
      modelFlag: 'zzz-nonexistent',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      knownProviders: ['openai', 'anthropic'],
    });

    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.error).toBe('Error: No models match "zzz-nonexistent".');
    }
  });

  it('passes through when target provider had fetch error and yielded no models', async () => {
    const failGroups = [makeGroup('failed-prov', [], { error: 'Connection refused' })];
    const deps = mockDeps(failGroups);
    const result = await resolveModelFlag({
      modelFlag: 'some-model:high',
      providerFlag: 'failed-prov',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      knownProviders: ['failed-prov'],
    });

    expect(result).toEqual<ModelResolutionResult>({
      status: 'passthrough',
      modelId: 'some-model',
      provider: 'failed-prov',
      reasoningEffort: 'high',
      warnings: ['warning: failed-prov: Connection refused'],
    });
  });

  it('resolves a vendor-slash id on the serving provider even when the vendor name is also a provider id', async () => {
    // Regression: `resolveModelFlag` used to narrow the catalog load to the
    // prefix-derived provider, so `anthropic/claude-3.5-sonnet` (a literal id
    // on openrouter) could never see openrouter's catalog and falsely
    // reported no_match or switched providers. Mirrors the cli.tsx call site:
    // no providerIds, no knownProviders overrides.
    registerProvider({ id: 'fake-anthropic', label: 'Fake Anthropic', fetchModels: async () => [] });
    registerProvider({ id: 'fake-openrouter', label: 'Fake OpenRouter', fetchModels: async () => [] });
    try {
      const fetcher = vi.fn(async (provider: string) => {
        if (provider === 'fake-anthropic') return [{ id: 'claude-3-5-sonnet-20241022', provider }];
        if (provider === 'fake-openrouter') return [{ id: 'fake-anthropic/claude-3.5-sonnet', provider }];
        return [];
      });
      const result = await resolveModelFlag({
        modelFlag: 'fake-anthropic/claude-3.5-sonnet',
        settingsService: { get: vi.fn(), getDynamic: vi.fn(() => []) } as any,
        loggingService: { warn: vi.fn() } as any,
        fetcher,
      });

      expect(fetcher).toHaveBeenCalledWith('fake-openrouter');
      expect(result).toEqual<ModelResolutionResult>({
        status: 'resolved',
        modelId: 'fake-anthropic/claude-3.5-sonnet',
        provider: 'fake-openrouter',
        reasoningEffort: undefined,
      });
    } finally {
      unregisterProvider('fake-anthropic');
      unregisterProvider('fake-openrouter');
    }
  });

  it('resolves a provider-prefixed pattern within that provider when the stripped pattern is an exact id', async () => {
    registerProvider({ id: 'fake-openai', label: 'Fake OpenAI', fetchModels: async () => [] });
    try {
      const fetcher = vi.fn(async (provider: string) => {
        if (provider === 'fake-openai') return [{ id: 'gpt-x', provider }];
        return [];
      });
      const result = await resolveModelFlag({
        modelFlag: 'fake-openai/gpt-x',
        settingsService: { get: vi.fn(), getDynamic: vi.fn(() => []) } as any,
        loggingService: { warn: vi.fn() } as any,
        fetcher,
      });

      expect(result).toEqual<ModelResolutionResult>({
        status: 'resolved',
        modelId: 'gpt-x',
        provider: 'fake-openai',
        reasoningEffort: undefined,
      });
    } finally {
      unregisterProvider('fake-openai');
    }
  });

  it('does not warn about a provider the early-exit strategy deliberately never loaded', async () => {
    // The exact match resolves off the first provider in priority order, so
    // the second provider is never attempted at all — its failure (if any)
    // must not leak into `warnings`, since we never actually asked it for
    // anything. Only a provider we DID try and that failed may warn.
    const warnGroups: ProviderModelGroup[] = [
      makeGroup('fake-healthy', [{ id: 'alpha-1' }]),
      makeGroup('fake-broken', [], { error: 'Connection refused' }),
    ];
    const deps = mockDeps(warnGroups);
    const result = await resolveModelFlag({
      modelFlag: 'alpha-1',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      knownProviders: ['fake-healthy', 'fake-broken'],
    });

    expect(deps.fetcher).not.toHaveBeenCalledWith('fake-broken');
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'alpha-1',
      provider: 'fake-healthy',
      reasoningEffort: undefined,
    });
  });

  it('still surfaces a warning for a provider that was loaded during widening and failed', async () => {
    // The first provider in order has no exact match, so resolution widens
    // and loads the rest concurrently. One of those actually-attempted
    // providers fails; its warning must survive even though a third provider
    // is what ultimately resolves the query.
    const warnGroups: ProviderModelGroup[] = [
      makeGroup('fake-empty', []),
      makeGroup('fake-broken', [], { error: 'Connection refused' }),
      makeGroup('fake-target', [{ id: 'alpha-99' }]),
    ];
    const deps = mockDeps(warnGroups);
    const result = await resolveModelFlag({
      modelFlag: 'alpha',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      knownProviders: ['fake-empty', 'fake-broken', 'fake-target'],
    });

    expect(deps.fetcher).toHaveBeenCalledWith('fake-broken');
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'alpha-99',
      provider: 'fake-target',
      reasoningEffort: undefined,
      warnings: ['warning: fake-broken: Connection refused'],
    });
  });

  it('returns cancelled when user aborts selection prompt', async () => {
    const prompter = vi.fn(async () => null);
    const deps = mockDeps(groups);
    const result = await resolveModelFlag({
      modelFlag: 'gpt-5',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      prompter,
      knownProviders: ['openai', 'anthropic'],
    });

    expect(result).toEqual<ModelResolutionResult>({
      status: 'cancelled',
      error: 'Cancelled.',
    });
  });

  it('preserves thinking suffix across interactive disambiguation', async () => {
    const prompter = vi.fn(async () => '2');
    const deps = mockDeps(groups);
    const result = await resolveModelFlag({
      modelFlag: 'gpt-5:high',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      prompter,
      knownProviders: ['openai', 'anthropic'],
    });

    expect(prompter).toHaveBeenCalledOnce();
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'gpt-5.4-mini',
      provider: 'openai',
      reasoningEffort: 'high',
    });
  });

  it('resolves silently via the first provider on an exact match, even when a later, unattempted provider also has that id', async () => {
    // Latency trade-off: resolution stops loading catalogs as soon as the
    // first provider in priority order produces an exact match, so it never
    // discovers whether a later provider it didn't need to load also has the
    // same id. This is the same mechanism that keeps `--model gpt-5.4` from
    // loading an unrelated provider's catalog; cross-provider id collisions
    // are rare enough that giving up exhaustive disambiguation for them is
    // an accepted trade-off.
    const multiExactGroups: ProviderModelGroup[] = [
      makeGroup('openai', [{ id: 'gpt-4o' }], { label: 'OpenAI' }),
      makeGroup('openrouter', [{ id: 'gpt-4o' }], { label: 'OpenRouter' }),
    ];
    const prompter = vi.fn(async () => '2');
    const deps = mockDeps(multiExactGroups);
    const result = await resolveModelFlag({
      modelFlag: 'gpt-4o',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      prompter,
      knownProviders: ['openai', 'openrouter'],
    });

    expect(prompter).not.toHaveBeenCalled();
    expect(deps.fetcher).not.toHaveBeenCalledWith('openrouter');
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'gpt-4o',
      provider: 'openai',
      reasoningEffort: undefined,
    });
  });

  it('handles whitespace trimming in flag and suffixes', () => {
    const parsed = parseModelFlag('  openai/gpt-5.4:medium  ', { knownProviders: ['openai'] });
    expect(parsed).toEqual({
      pattern: 'gpt-5.4',
      rawPattern: 'openai/gpt-5.4',
      provider: 'openai',
      reasoningEffort: 'medium',
    });
  });

  it('passes through when target provider catalog has 0 models', async () => {
    const emptyGroups = [makeGroup('empty-prov', [])];
    const deps = mockDeps(emptyGroups);
    const result = await resolveModelFlag({
      modelFlag: 'some-model',
      providerFlag: 'empty-prov',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      knownProviders: ['empty-prov'],
    });

    expect(result).toEqual<ModelResolutionResult>({
      status: 'passthrough',
      modelId: 'some-model',
      provider: 'empty-prov',
      reasoningEffort: undefined,
    });
  });

  it('passes through when all providers yield 0 loaded models without explicit error', async () => {
    const emptyGroups = [makeGroup('prov-a', []), makeGroup('prov-b', [])];
    const deps = mockDeps(emptyGroups);
    const result = await resolveModelFlag({
      modelFlag: 'fallback-model',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      knownProviders: ['prov-a', 'prov-b'],
    });

    expect(result).toEqual<ModelResolutionResult>({
      status: 'passthrough',
      modelId: 'fallback-model',
      provider: undefined,
      reasoningEffort: undefined,
    });
  });

  it('reports cached catalog path in error message when target provider does not match', async () => {
    const targetGroups = [makeGroup('codex', [{ id: 'gpt-5.3-codex' }])];
    const deps = mockDeps(targetGroups);
    const result = await resolveModelFlag({
      modelFlag: 'gpt-6-astra',
      providerFlag: 'codex',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      knownProviders: ['codex'],
    });

    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.error).toContain('Error: No models match "gpt-6-astra".');
      expect(result.error).toContain('The cached catalog for codex may be stale');
      expect(result.error).toContain('codex.json');
    }
  });

  it('does not load an unrelated provider once an earlier one in priority order has an exact match', async () => {
    // `--model gpt-5.4` (no prefix, no --provider) must resolve off the first
    // credentialed provider in order without ever touching a later one.
    const latencyGroups: ProviderModelGroup[] = [
      makeGroup('openai', [{ id: 'gpt-5.4', name: 'GPT 5.4' }]),
      makeGroup('anthropic', [{ id: 'claude-sonnet-4', name: 'Sonnet 4' }]),
    ];
    const deps = mockDeps(latencyGroups);
    const result = await resolveModelFlag({
      modelFlag: 'gpt-5.4',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      knownProviders: ['openai', 'anthropic'],
    });

    expect(deps.fetcher).toHaveBeenCalledWith('openai');
    expect(deps.fetcher).not.toHaveBeenCalledWith('anthropic');
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'gpt-5.4',
      provider: 'openai',
      reasoningEffort: undefined,
    });
  });

  it('tries a provider-style prefix first, then widens to find a literal id on a different provider', async () => {
    // The prefix-derived provider ("openai") is attempted first (latency win
    // when it's right), but coming up empty there must still widen to the
    // rest of the candidate space rather than dead-ending — this is the
    // aggregator-id correctness guarantee, made lazy: `matchModels`'s stage 1
    // already checks other providers for a literal id match, but only if
    // their catalogs were actually loaded.
    const widenGroups: ProviderModelGroup[] = [
      makeGroup('openai', []),
      makeGroup('openrouter', [{ id: 'openai/claude-x' }]),
    ];
    const callOrder: string[] = [];
    const fetcher = vi.fn(async (provider: string) => {
      callOrder.push(provider);
      const group = widenGroups.find((g) => g.provider === provider);
      return group?.models ?? [];
    });
    const result = await resolveModelFlag({
      modelFlag: 'openai/claude-x',
      settingsService: { get: vi.fn(), getDynamic: vi.fn(() => []) } as any,
      loggingService: { warn: vi.fn() } as any,
      fetcher,
      providerIds: ['openai', 'openrouter'],
      knownProviders: ['openai', 'openrouter'],
    });

    expect(callOrder).toEqual(['openai', 'openrouter']);
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'openai/claude-x',
      provider: 'openrouter',
      reasoningEffort: undefined,
    });
  });

  it('diverges from the prefix case: explicit --provider narrows permanently and never widens', async () => {
    // Same conceptual search as the test above ("claude-x" scoped to
    // "openai") — a parsed prefix widens and finds it on openrouter, but an
    // EXPLICIT --provider flag must not: it's the user deliberately scoping
    // the search (and it also sets agent.provider for the session), so a
    // miss there errors out with the pre-existing stale-cache hint instead of
    // silently resolving to a provider the user didn't name. Note the ids
    // here are bare ("claude-x"), not vendor-prefixed like the widen test
    // above, because parseModelFlag never strips a prefix off the pattern
    // when --provider is given explicitly (the whole flag is the pattern).
    const groups: ProviderModelGroup[] = [
      makeGroup('openai', [{ id: 'gpt-4' }]),
      makeGroup('openrouter', [{ id: 'claude-x' }]),
    ];
    const fetcher = vi.fn(async (provider: string) => {
      const group = groups.find((g) => g.provider === provider);
      return group?.models ?? [];
    });
    const result = await resolveModelFlag({
      modelFlag: 'claude-x',
      providerFlag: 'openai',
      settingsService: { get: vi.fn(), getDynamic: vi.fn(() => []) } as any,
      loggingService: { warn: vi.fn() } as any,
      fetcher,
      providerIds: ['openai', 'openrouter'],
      knownProviders: ['openai', 'openrouter'],
    });

    expect(fetcher).not.toHaveBeenCalledWith('openrouter');
    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.error).toContain('Error: No models match "claude-x".');
      expect(result.error).toContain('The cached catalog for openai may be stale');
    }
  });

  it('loads a full fuzzy sweep concurrently and still returns matches spanning every provider', async () => {
    // No prefix, no exact match anywhere: every provider must be consulted
    // for a correct fuzzy sweep. Assert on the *set* of attempted providers
    // (order-independent) since concurrent loads race, plus that matches
    // from every provider that has one come back — not just the first tried.
    const sweepGroups: ProviderModelGroup[] = [
      makeGroup('providerA', [{ id: 'nova-alpha' }]),
      makeGroup('providerB', [{ id: 'nova-beta' }]),
      makeGroup('providerC', [{ id: 'nova-gamma' }]),
    ];
    const deps = mockDeps(sweepGroups);
    const result = await resolveModelFlag({
      modelFlag: 'nova',
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      providerIds: deps.providerIds,
      prompter: vi.fn(async () => '1'),
      knownProviders: ['providerA', 'providerB', 'providerC'],
    });

    expect(deps.fetcher).toHaveBeenCalledWith('providerA');
    expect(deps.fetcher).toHaveBeenCalledWith('providerB');
    expect(deps.fetcher).toHaveBeenCalledWith('providerC');
    expect(result.status).toBe('resolved');
  });
});
