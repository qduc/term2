import { expect, it } from 'vitest';
import {
  applySubagentPoolModelPick,
  buildSubagentPoolListItems,
  formatSubagentPoolReasoning,
  mergeSubagentPoolModels,
  resolveSubagentPoolBrowseProvider,
  resolveSubagentPoolModelSelection,
  serializeTierPoolEntries,
  tierPoolEntryForPick,
} from './use-subagent-pool-selection.js';

it('offers add and save actions below the pool entries', () => {
  const emptyActions = buildSubagentPoolListItems([]).filter((item) => item.kind === 'action');
  const twoEntryActions = buildSubagentPoolListItems([{ model: 'gpt-5' }, { model: 'sonnet' }]).filter(
    (item) => item.kind === 'action',
  );

  expect(emptyActions.map((item) => item.action)).toEqual(['add', 'save']);
  expect(twoEntryActions.map((item) => item.action)).toEqual(['add', 'save']);
});

it('describes inherited and explicit reasoning without changing stored values', () => {
  expect(formatSubagentPoolReasoning(undefined, 'Mentor')).toBe('Inherit mentor reasoning');
  expect(formatSubagentPoolReasoning('default', 'Mentor')).toBe('Provider default');
  expect(formatSubagentPoolReasoning('high', 'Mentor')).toBe('High');
  expect(formatSubagentPoolReasoning('none', 'Mentor')).toBe('None');
  expect(formatSubagentPoolReasoning(undefined, 'Explorer')).toBe('Inherit explorer reasoning');
});

it('offers saved pool IDs and the current draft value when they are absent from the provider catalog', () => {
  const models = mergeSubagentPoolModels({
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
  expect(models[1]).toMatchObject({ name: 'In pool', provider: 'openai' });
});

it('keeps catalog metadata when a saved pool model is already known to the provider', () => {
  const models = mergeSubagentPoolModels({
    catalogModels: [{ id: 'known-model', name: 'Known Model', provider: 'openai' }],
    entries: [{ model: 'known-model', provider: 'openai' }],
    provider: 'openai',
    currentModel: 'known-model',
  });

  expect(models).toEqual([{ id: 'known-model', name: 'Known Model', provider: 'openai' }]);
});

it('selects the highlighted catalog model but accepts a typed custom ID when there is no match', () => {
  const models = [{ id: 'catalog-model', provider: 'openai' }];

  expect(resolveSubagentPoolModelSelection(models, 0, 'custom-model')).toBe('catalog-model');
  expect(resolveSubagentPoolModelSelection([], 0, ' custom-model ')).toBe('custom-model');
});

it('pins both model and provider when a catalog pick is applied to a draft', () => {
  expect(applySubagentPoolModelPick({ model: '', _isNew: true }, 'gpt-5', 'openai')).toEqual({
    model: 'gpt-5',
    provider: 'openai',
    _isNew: true,
  });

  expect(
    applySubagentPoolModelPick(
      { model: 'old', provider: 'openrouter', reasoningEffort: 'high' },
      'claude-sonnet',
      'anthropic',
    ),
  ).toEqual({
    model: 'claude-sonnet',
    provider: 'anthropic',
    reasoningEffort: 'high',
  });
});

it('resolves the model browser starting provider from the entry, then the role, then the agent', () => {
  expect(
    resolveSubagentPoolBrowseProvider({
      draftProvider: 'openrouter',
      roleProvider: 'openai',
      agentProvider: 'anthropic',
    }),
  ).toBe('openrouter');
  expect(
    resolveSubagentPoolBrowseProvider({
      draftProvider: undefined,
      roleProvider: 'openai',
      agentProvider: 'anthropic',
    }),
  ).toBe('openai');
  expect(
    resolveSubagentPoolBrowseProvider({
      draftProvider: undefined,
      roleProvider: undefined,
      agentProvider: 'anthropic',
    }),
  ).toBe('anthropic');
});

it('pins the provider of a tier pool pick made from another provider catalog', () => {
  // Regression: codex/gpt-6-luna picked into a DeepSeek-provider tier was
  // stored bare and sent to DeepSeek.
  expect(tierPoolEntryForPick('gpt-6-luna', 'codex', 'DeepSeek')).toEqual({ model: 'gpt-6-luna', provider: 'codex' });
  expect(tierPoolEntryForPick('deepseek-flash', 'DeepSeek', 'DeepSeek')).toEqual({ model: 'deepseek-flash' });
});

it('persists pinned tier pool entries with their provider and bare entries as ids', () => {
  expect(serializeTierPoolEntries([{ model: 'deepseek-flash' }, { model: 'gpt-6-luna', provider: 'codex' }])).toEqual([
    'deepseek-flash',
    { model: 'gpt-6-luna', provider: 'codex' },
  ]);
});

it('labels a pinned pool entry with its provider', () => {
  const labels = buildSubagentPoolListItems([{ model: 'deepseek-flash' }, { model: 'gpt-6-luna', provider: 'codex' }])
    .filter((item) => item.kind === 'entry')
    .map((item) => item.label);
  expect(labels).toEqual(['deepseek-flash', 'gpt-6-luna @ codex']);
});
