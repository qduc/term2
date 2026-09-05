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

  it('fuzzy matches across multiple providers when unconstrained', () => {
    const parsed = parseModelFlag('sonnet');
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(false);
    expect(result.matches.map((m) => `${m.provider}/${m.model.id}`)).toEqual([
      'anthropic/claude-3-5-sonnet-20241022',
      'anthropic/claude-sonnet-4',
      'openrouter/anthropic/claude-3.5-sonnet',
    ]);
  });

  it('fuzzy matches constrained to provider when provider is specified', () => {
    const parsed = parseModelFlag('anthropic/sonnet', { knownProviders: ['anthropic'] });
    const result = matchModels(groups, parsed);
    expect(result.exact).toBe(false);
    expect(result.matches.map((m) => `${m.provider}/${m.model.id}`)).toEqual([
      'anthropic/claude-3-5-sonnet-20241022',
      'anthropic/claude-sonnet-4',
    ]);
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

  it('surfaces fetch warnings when resolution proceeds despite a failed provider catalog', async () => {
    registerProvider({ id: 'fake-healthy', label: 'Fake Healthy', fetchModels: async () => [] });
    registerProvider({ id: 'fake-broken', label: 'Fake Broken', fetchModels: async () => [] });
    try {
      const fetcher = vi.fn(async (provider: string) => {
        if (provider === 'fake-healthy') return [{ id: 'alpha-1', provider }];
        if (provider === 'fake-broken') throw new Error('Connection refused');
        return [];
      });
      const result = await resolveModelFlag({
        modelFlag: 'alpha-1',
        settingsService: { get: vi.fn(), getDynamic: vi.fn(() => []) } as any,
        loggingService: { warn: vi.fn() } as any,
        fetcher,
      });

      expect(result).toEqual<ModelResolutionResult>({
        status: 'resolved',
        modelId: 'alpha-1',
        provider: 'fake-healthy',
        reasoningEffort: undefined,
        warnings: ['warning: fake-broken: Connection refused'],
      });
    } finally {
      unregisterProvider('fake-healthy');
      unregisterProvider('fake-broken');
    }
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

  it('disambiguates between multiple exact matches across providers', async () => {
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

    expect(prompter).toHaveBeenCalledOnce();
    expect(result).toEqual<ModelResolutionResult>({
      status: 'resolved',
      modelId: 'gpt-4o',
      provider: 'openrouter',
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
});
