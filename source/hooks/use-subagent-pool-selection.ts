import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { SETTING_KEYS } from '../services/settings/settings-service.js';
import { type ModelInfo } from '../services/model-service.js';
import { ModelCatalogSession, orderedProviderIds } from '../services/models/model-catalog-session.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { loadProviderItems, type ProviderSelectionItem } from '../providers/provider-service.js';
import { useSelection } from './use-selection.js';
import type { MenuEffect } from '../components/input/menu-types.js';
import { filterUnifiedModels, mergeUnifiedModels } from '../services/models/unified-model-catalog.js';
import { getProviderIds } from '../providers/index.js';
import { getFavoriteModelInfos, serializeFavorite } from '../services/models/model-favorites.js';
import { getSubagentPoolFallbackProviderKey } from '../services/subagents/subagent-pool-config.js';

export const SUBAGENT_POOL_REASONING_EFFORTS = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;
export type SubagentPoolReasoningEffort = (typeof SUBAGENT_POOL_REASONING_EFFORTS)[number];
export type SubagentPoolEntry = {
  model: string;
  provider?: string;
  reasoningEffort?: SubagentPoolReasoningEffort;
};
export type SubagentPoolDraft = SubagentPoolEntry & { _isNew?: boolean };
export type SubagentPoolPhase =
  | 'list'
  | 'edit_fields'
  | 'edit_model'
  | 'edit_provider'
  | 'edit_reasoning'
  | 'confirm_delete'
  | 'confirm_discard'
  | 'reorder';

export type SubagentPoolMenuItem =
  | { kind: 'entry'; entry: SubagentPoolEntry; index: number; label: string }
  | { kind: 'action'; action: 'add' | 'reorder' | 'save' | 'cancel'; label: string; tone?: 'default' | 'destructive' }
  | { kind: 'field'; field: 'model' | 'provider' | 'reasoning'; label: string; detail: string }
  | { kind: 'provider'; id: string; label: string }
  | { kind: 'reasoning'; value: SubagentPoolReasoningEffort | undefined; label: string }
  | { kind: 'reorder-entry'; entry: SubagentPoolEntry; index: number; label: string };

const subagentPoolEntrySchema = z.object({
  model: z.string().min(1, 'Model is required'),
  provider: z.string().min(1, 'Provider cannot be empty').optional(),
  reasoningEffort: z.enum(SUBAGENT_POOL_REASONING_EFFORTS).optional(),
});
const MAX_SUBAGENT_POOL_ENTRIES = 8;
const subagentPoolSchema = (roleLabel: string) =>
  z
    .array(subagentPoolEntrySchema)
    .max(MAX_SUBAGENT_POOL_ENTRIES, `${roleLabel} pool cannot contain more than 8 entries`);

const noOpLoggingService: ILoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

// Tier model pools persist plain model-id strings (a bare string normalizes
// to a single-entry pool); the editor surfaces them as {model} entries.
const tierPoolSchema = z.preprocess(
  (value) =>
    value === undefined || value === null || value === '' ? undefined : Array.isArray(value) ? value : [value],
  z.array(z.string().min(1)).max(MAX_SUBAGENT_POOL_ENTRIES),
);

const cloneEntries = (value: unknown, roleLabel: string, entryShape: 'entries' | 'models'): SubagentPoolEntry[] => {
  if (entryShape === 'models') {
    const parsed = tierPoolSchema.safeParse(value);
    return parsed.success ? parsed.data.map((model) => ({ model })) : [];
  }
  const parsed = subagentPoolSchema(roleLabel).safeParse(value);
  return parsed.success ? parsed.data.map((entry) => ({ ...entry })) : [];
};

export function formatSubagentPoolProvider(provider: string | undefined, roleLabel: string): string {
  return provider || `Inherit ${roleLabel.toLowerCase()} provider`;
}

export function formatSubagentPoolReasoning(
  reasoningEffort: SubagentPoolReasoningEffort | undefined,
  roleLabel: string,
): string {
  switch (reasoningEffort) {
    case 'none':
      return 'None';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra high';
    case undefined:
      return `Inherit ${roleLabel.toLowerCase()} reasoning`;
    case 'default':
      return 'Provider default';
  }
}

export function mergeSubagentPoolModels({
  catalogModels,
  entries,
  provider,
  currentModel,
}: {
  catalogModels: readonly ModelInfo[];
  entries: readonly SubagentPoolEntry[];
  provider: string;
  currentModel: string;
}): ModelInfo[] {
  const catalogIds = new Set(catalogModels.map((model) => model.id));
  const suggestedIds = new Set<string>();
  const suggestions: ModelInfo[] = [];
  const addSuggestion = (id: string, name: string) => {
    if (!id || catalogIds.has(id) || suggestedIds.has(id)) return;
    suggestedIds.add(id);
    suggestions.push({ id, name, provider });
  };

  addSuggestion(currentModel, 'Current model (not in catalog)');
  for (const entry of entries) {
    if (entry.provider === undefined || entry.provider === provider) addSuggestion(entry.model, 'In pool');
  }
  return [...suggestions, ...catalogModels];
}

export function resolveSubagentPoolModelSelection(
  models: readonly ModelInfo[],
  selectedIndex: number,
  typedModel: string,
): string {
  return models[selectedIndex]?.id ?? typedModel.trim();
}

/** Starting provider for custom pool model rows. */
export function resolveSubagentPoolBrowseProvider({
  draftProvider,
  roleProvider,
  agentProvider,
}: {
  draftProvider?: string;
  roleProvider?: string;
  agentProvider?: string;
}): string {
  return draftProvider || roleProvider || agentProvider || '';
}

/** Apply a model catalog pick: pin both model id and its provider. */
export function applySubagentPoolModelPick(
  draft: SubagentPoolDraft,
  model: string,
  provider: string,
): SubagentPoolDraft {
  return {
    ...draft,
    model,
    ...(provider ? { provider } : {}),
  };
}

export function formatSubagentPoolEntry(entry: SubagentPoolEntry): string {
  const provider = entry.provider ? ` @ ${entry.provider}` : '';
  const effort = entry.reasoningEffort && entry.reasoningEffort !== 'default' ? ` (${entry.reasoningEffort})` : '';
  return `${entry.model}${provider}${effort}`;
}

export function buildSubagentPoolListItems(entries: readonly SubagentPoolEntry[]): SubagentPoolMenuItem[] {
  const actions: SubagentPoolMenuItem[] = [];
  if (entries.length < MAX_SUBAGENT_POOL_ENTRIES) actions.push({ kind: 'action', action: 'add', label: 'Add Entry' });
  if (entries.length > 1) actions.push({ kind: 'action', action: 'reorder', label: 'Reorder Entries' });
  actions.push({ kind: 'action', action: 'save', label: 'Save Changes' });
  return [
    ...entries.map((entry, index) => ({
      kind: 'entry' as const,
      entry,
      index,
      label: entry.model,
    })),
    ...actions,
  ];
}

export type SubagentPoolSelectionConfig = {
  /** Setting key the pool is persisted under (e.g. `agent.mentorPool`). */
  settingKey: string;
  /** Human label used in editor copy ("Mentor", "Smart", ...). */
  roleLabel: string;
  /** 'models' pools hold plain model-id strings (tiers); 'entries' pools hold rich entries (mentor). */
  entryShape: 'entries' | 'models';
  /** Setting key the "inherit provider" fallback reads from, when one exists. */
  fallbackProviderKey?: string;
};

export function useSubagentPoolSelection(
  settingsService: SettingsService,
  active: boolean,
  loggingService: ILoggingService | undefined,
  config: SubagentPoolSelectionConfig,
) {
  const { settingKey, roleLabel, entryShape } = config;
  const fallbackProviderKey = config.fallbackProviderKey ?? getSubagentPoolFallbackProviderKey(settingKey);
  const { input, setInput, replaceInput } = useInputContext();
  const [phase, setPhase] = useState<SubagentPoolPhase>('list');
  const [entries, setEntries] = useState<SubagentPoolEntry[]>([]);
  const [draft, setDraft] = useState<SubagentPoolDraft | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [reorderList, setReorderList] = useState<SubagentPoolEntry[]>([]);
  const [providerItems, setProviderItems] = useState<ProviderSelectionItem[]>([]);
  const [draftModified, setDraftModified] = useState(false);
  const [discardFromPhase, setDiscardFromPhase] = useState<SubagentPoolPhase | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const catalogSession = useMemo(
    () => new ModelCatalogSession({ settingsService, loggingService: loggingService ?? noOpLoggingService }),
    [loggingService, settingsService],
  );
  const [catalogs, setCatalogs] = useState<Map<string, ModelInfo[]>>(new Map());
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0);
  const [modelScrollOffset, setModelScrollOffset] = useState(0);
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  const [modelTab, setModelTab] = useState<'favorites' | 'all'>('all');
  const [browsingProvider, setBrowsingProvider] = useState<string | null>(null);
  const settingsServiceRef = useRef(settingsService);
  settingsServiceRef.current = settingsService;
  const roleProvider = fallbackProviderKey
    ? (settingsService.get(fallbackProviderKey as any) as string | undefined)
    : undefined;
  const fallbackModelProvider = resolveSubagentPoolBrowseProvider({
    draftProvider: draft?.provider,
    roleProvider,
    agentProvider: settingsService.get(SETTING_KEYS.AGENT_PROVIDER),
  });
  const modelProvider = browsingProvider ?? fallbackModelProvider;
  const providerIds = useMemo(
    () => orderedProviderIds(settingsService, getProviderIds()),
    [settingsService, modelRefreshKey],
  );
  const favoriteModels = useMemo(() => getFavoriteModelInfos(settingsService), [settingsService, modelRefreshKey]);
  const favoriteKeys = useMemo(
    () => new Set(favoriteModels.map((model) => serializeFavorite(model.provider, model.id))),
    [favoriteModels],
  );
  const modelItems = useMemo(() => {
    const unified = mergeUnifiedModels(providerIds, catalogs, favoriteModels);
    return mergeSubagentPoolModels({
      catalogModels: unified,
      entries,
      provider: fallbackModelProvider,
      currentModel: draft?.model ?? '',
    });
  }, [catalogs, draft?.model, entries, fallbackModelProvider, favoriteModels, providerIds]);
  const filteredModels = useMemo(
    () =>
      filterUnifiedModels(
        modelTab === 'favorites'
          ? modelItems.filter((model) => favoriteKeys.has(serializeFavorite(model.provider, model.id)))
          : modelItems,
        input,
        undefined,
      ),
    [favoriteKeys, input, modelItems, modelTab],
  );

  const activeItems = useMemo<SubagentPoolMenuItem[]>(() => {
    if (phase === 'list') {
      return buildSubagentPoolListItems(entries);
    }
    if (phase === 'edit_fields') {
      if (!draft) return [];
      return [
        { kind: 'field', field: 'model', label: 'Model', detail: draft.model || '<empty>' },
        {
          kind: 'field',
          field: 'provider',
          label: 'Provider',
          detail: formatSubagentPoolProvider(draft.provider, roleLabel),
        },
        {
          kind: 'field',
          field: 'reasoning',
          label: 'Reasoning',
          detail: formatSubagentPoolReasoning(draft.reasoningEffort, roleLabel),
        },
        { kind: 'action', action: 'save', label: 'Save Changes' },
        { kind: 'action', action: 'cancel', label: 'Cancel' },
      ];
    }
    if (phase === 'edit_provider') {
      return [
        { kind: 'provider', id: '', label: `Inherit (use ${roleLabel.toLowerCase()} provider)` },
        ...providerItems.map((provider) => ({ kind: 'provider' as const, id: provider.id, label: provider.label })),
      ];
    }
    if (phase === 'edit_reasoning') {
      return [
        { kind: 'reasoning' as const, value: undefined, label: formatSubagentPoolReasoning(undefined, roleLabel) },
        ...SUBAGENT_POOL_REASONING_EFFORTS.map((value) => ({
          kind: 'reasoning' as const,
          value,
          label: formatSubagentPoolReasoning(value, roleLabel),
        })),
      ];
    }
    if (phase === 'confirm_delete') {
      return [
        { kind: 'action', action: 'save', label: 'Yes, delete entry', tone: 'destructive' },
        { kind: 'action', action: 'cancel', label: 'No, keep it' },
      ];
    }
    if (phase === 'confirm_discard') {
      return [
        { kind: 'action', action: 'save', label: 'Yes, discard changes', tone: 'destructive' },
        { kind: 'action', action: 'cancel', label: 'No, keep editing' },
      ];
    }
    return reorderList.map((entry, index) => ({
      kind: 'reorder-entry' as const,
      index,
      entry,
      label: entry.model,
    }));
  }, [draft, entries, phase, providerItems, reorderList, roleLabel]);

  const selection = useSelection(activeItems);

  useEffect(() => {
    if (!active) return;
    const currentSettingsService = settingsServiceRef.current;
    const loaded = cloneEntries(currentSettingsService.get(settingKey as any), roleLabel, entryShape);
    setEntries(loaded);
    setProviderItems(loadProviderItems(currentSettingsService));
    setPhase('list');
    setDraft(null);
    setEditingIndex(null);
    setReorderList([]);
    setDraftModified(false);
    setDiscardFromPhase(null);
    setErrorMessage(null);
    setFieldErrors({});
  }, [active, entryShape, roleLabel, settingKey]);

  useEffect(() => {
    if (!active || phase !== 'edit_model' || providerIds.length === 0) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    const cached = new Map(providerIds.map((provider) => [provider, catalogSession.getCached(provider) ?? []]));
    setCatalogs(cached);
    setModelSelectedIndex(0);
    setModelScrollOffset(0);
    setModelError(null);

    catalogSession.begin();
    let disposed = false;
    const load = async () => {
      setModelLoading(true);
      try {
        const results = await Promise.allSettled(
          providerIds.map(async (provider) => ({ provider, result: await catalogSession.load(provider) })),
        );
        if (disposed) return;
        const next = new Map(cached);
        const failures: string[] = [];
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value.result.kind !== 'stale') {
            next.set(result.value.provider, result.value.result.models);
          } else if (result.status === 'rejected') {
            failures.push(String(result.reason));
          }
        }
        setCatalogs(next);
        if (failures.length > 0) setModelError('Some providers failed: ' + failures.join(', '));
      } catch (error) {
        if (!disposed) setModelError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) setModelLoading(false);
      }
    };
    void load();
    return () => {
      disposed = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [active, catalogSession, modelRefreshKey, phase, providerIds]);

  useEffect(() => {
    // Changing the search text starts a new list navigation session.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModelSelectedIndex(0);
    setModelScrollOffset(0);
  }, [input]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModelSelectedIndex((index) => Math.min(index, Math.max(0, filteredModels.length - 1)));
  }, [filteredModels.length]);

  useEffect(() => {
    if (modelSelectedIndex < modelScrollOffset) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModelScrollOffset(modelSelectedIndex);
    } else if (modelSelectedIndex >= modelScrollOffset + 10) {
      setModelScrollOffset(modelSelectedIndex - 9);
    }
  }, [modelScrollOffset, modelSelectedIndex]);

  useEffect(() => {
    selection.setSelectedIndex(0);
  }, [phase, selection.setSelectedIndex]);

  const resolveBrowseProvider = useCallback(
    (draftProvider?: string) =>
      resolveSubagentPoolBrowseProvider({
        draftProvider,
        roleProvider: fallbackProviderKey
          ? (settingsService.get(fallbackProviderKey as any) as string | undefined)
          : undefined,
        agentProvider: settingsService.get(SETTING_KEYS.AGENT_PROVIDER),
      }),
    [fallbackProviderKey, settingsService],
  );

  const openDraft = useCallback(
    (entry: SubagentPoolEntry | null, index: number | null) => {
      setDraft(entry ? { ...entry, _isNew: false } : { model: '', _isNew: true });
      setEditingIndex(index);
      setDraftModified(false);
      setErrorMessage(null);
      setFieldErrors({});
      // Model-only pools (tiers) always edit through the model menu; rich
      // pools jump there for new entries so the user picks model + provider
      // in one step instead of a separate provider field first.
      if (entry === null || entryShape === 'models') {
        setBrowsingProvider(resolveBrowseProvider(undefined));
        setPhase('edit_model');
        replaceInput('');
      } else {
        setBrowsingProvider(null);
        setPhase('edit_fields');
        setInput('');
      }
    },
    [entryShape, replaceInput, resolveBrowseProvider, setInput],
  );

  const saveDraft = useCallback(() => {
    if (!draft) return;
    const result = subagentPoolEntrySchema.safeParse({
      model: draft.model.trim(),
      ...(draft.provider === undefined ? {} : { provider: draft.provider.trim() }),
      ...(draft.reasoningEffort === undefined ? {} : { reasoningEffort: draft.reasoningEffort }),
    });
    if (!result.success) {
      const errors: Record<string, string> = {};
      for (const issue of result.error.issues) errors[String(issue.path[0] ?? 'model')] = issue.message;
      setFieldErrors(errors);
      setErrorMessage('Fix the highlighted fields before saving.');
      return;
    }
    const next = { ...result.data };
    setEntries((current) => {
      if (draft._isNew || editingIndex === null) return [...current, next];
      return current.map((entry, index) => (index === editingIndex ? next : entry));
    });
    setDraft(null);
    setEditingIndex(null);
    setDraftModified(true);
    setFieldErrors({});
    setErrorMessage(null);
    setPhase('list');
    selection.setSelectedIndex(0);
    setInput('');
  }, [draft, editingIndex, setInput, selection.setSelectedIndex]);

  const selectItem = useCallback(() => {
    const item = activeItems[selection.selectedIndex];
    if (!item) return;
    if (phase === 'list') {
      if (item.kind === 'entry') openDraft(item.entry, item.index);
      else if (item.kind === 'action' && item.action === 'add') openDraft(null, null);
      else if (item.kind === 'action' && item.action === 'reorder') {
        setReorderList(entries.map((entry) => ({ ...entry })));
        setPhase('reorder');
        selection.setSelectedIndex(0);
      }
      return;
    }
    if (phase === 'edit_fields' && draft) {
      if (item.kind === 'field') {
        setErrorMessage(null);
        setFieldErrors({});
        if (item.field === 'model') {
          setBrowsingProvider(resolveBrowseProvider(draft.provider));
          setPhase('edit_model');
          // Open with an empty filter; the existing model remains in the draft
          // and is only replaced if the user explicitly selects another row.
          replaceInput('');
        } else if (item.field === 'provider') {
          setPhase('edit_provider');
          selection.setSelectedIndex(
            draft.provider ? providerItems.findIndex((provider) => provider.id === draft.provider) + 1 : 0,
          );
          setInput('');
        } else {
          setPhase('edit_reasoning');
          selection.setSelectedIndex(
            draft.reasoningEffort === undefined
              ? 0
              : SUBAGENT_POOL_REASONING_EFFORTS.indexOf(draft.reasoningEffort) + 1,
          );
          setInput('');
        }
      } else if (item.kind === 'action' && item.action === 'save') saveDraft();
      else if (item.kind === 'action' && item.action === 'cancel') {
        setDraft(null);
        setEditingIndex(null);
        setPhase('list');
        selection.setSelectedIndex(0);
        setInput('');
      }
      return;
    }
    if (phase === 'edit_provider' && item.kind === 'provider' && draft) {
      setDraft({ ...draft, provider: item.id || undefined });
      setDraftModified(true);
      setPhase('edit_fields');
      selection.setSelectedIndex(1);
      setInput('');
      return;
    }
    if (phase === 'edit_reasoning' && item.kind === 'reasoning' && draft) {
      // Keep an explicitly stored `default` distinct from an omitted value:
      // the runner treats an omitted value as falling back to the role
      // setting, while `default` uses the provider default.
      setDraft({ ...draft, reasoningEffort: item.value });
      setDraftModified(true);
      setPhase('edit_fields');
      selection.setSelectedIndex(2);
      setInput('');
      return;
    }
    if (phase === 'confirm_delete' && item.kind === 'action') {
      if (item.action === 'save' && editingIndex !== null) {
        setEntries((current) => current.filter((_, index) => index !== editingIndex));
        setDraftModified(true);
      }
      setDraft(null);
      setEditingIndex(null);
      setPhase('list');
      selection.setSelectedIndex(0);
      return;
    }
    if (phase === 'confirm_discard' && item.kind === 'action') {
      if (item.action === 'save') {
        setDraft(null);
        setEditingIndex(null);
        setPhase('list');
        selection.setSelectedIndex(0);
        setDraftModified(true);
      } else if (discardFromPhase) {
        setPhase(discardFromPhase);
        selection.setSelectedIndex(0);
      }
      setDiscardFromPhase(null);
    }
  }, [
    activeItems,
    draft,
    discardFromPhase,
    editingIndex,
    entries,
    openDraft,
    phase,
    providerItems,
    replaceInput,
    resolveBrowseProvider,
    saveDraft,
    selection.selectedIndex,
    setInput,
    selection.setSelectedIndex,
  ]);

  const requestDelete = useCallback(() => {
    if (phase !== 'list') return;
    const item = activeItems[selection.selectedIndex];
    if (item?.kind !== 'entry') return;
    setEditingIndex(item.index);
    setPhase('confirm_delete');
    selection.setSelectedIndex(1);
  }, [activeItems, phase, selection.selectedIndex, selection.setSelectedIndex]);

  const saveModel = useCallback(
    (value: string, provider: string) => {
      if (phase !== 'edit_model' || !draft) return false;
      const model = value.trim();
      if (!model) {
        setFieldErrors({ model: 'Model is required' });
        setErrorMessage('Fix the highlighted fields before saving.');
        return false;
      }
      if (entryShape === 'models') {
        // Model-only pools commit immediately: there is no provider or
        // reasoning field to review afterwards — the tier's own provider
        // and reasoning settings apply.
        const next: SubagentPoolEntry = { model };
        setEntries((current) => {
          if (draft._isNew || editingIndex === null) return [...current, next];
          return current.map((entry, index) => (index === editingIndex ? next : entry));
        });
        setDraft(null);
        setEditingIndex(null);
        setDraftModified(true);
        setFieldErrors({});
        setErrorMessage(null);
        setBrowsingProvider(null);
        setPhase('list');
        selection.setSelectedIndex(0);
        setInput('');
        return true;
      }
      // Pin the provider belonging to the selected unified row.
      setDraft(applySubagentPoolModelPick(draft, model, provider));
      setDraftModified(true);
      setFieldErrors({});
      setErrorMessage(null);
      setBrowsingProvider(null);
      setPhase('edit_fields');
      selection.setSelectedIndex(0);
      setInput('');
      return true;
    },
    [draft, editingIndex, entryShape, phase, setInput, selection.setSelectedIndex],
  );

  const selectModel = useCallback(
    (typedValue: string) => {
      const selected = filteredModels[modelSelectedIndex];
      return saveModel(
        resolveSubagentPoolModelSelection(filteredModels, modelSelectedIndex, typedValue),
        selected?.provider ?? modelProvider,
      );
    },
    [filteredModels, modelProvider, modelSelectedIndex, saveModel],
  );

  const moveModelUp = useCallback(() => {
    setModelSelectedIndex((index) =>
      filteredModels.length === 0 ? 0 : index > 0 ? index - 1 : filteredModels.length - 1,
    );
  }, [filteredModels.length]);

  const moveModelDown = useCallback(() => {
    setModelSelectedIndex((index) =>
      filteredModels.length === 0 ? 0 : index < filteredModels.length - 1 ? index + 1 : 0,
    );
  }, [filteredModels.length]);

  const moveModelHome = useCallback(() => setModelSelectedIndex(0), []);
  const moveModelEnd = useCallback(
    () => setModelSelectedIndex(Math.max(0, filteredModels.length - 1)),
    [filteredModels.length],
  );
  const pageModelUp = useCallback(() => setModelSelectedIndex((index) => Math.max(0, index - 10)), []);
  const pageModelDown = useCallback(
    () => setModelSelectedIndex((index) => Math.min(Math.max(0, filteredModels.length - 1), index + 10)),
    [filteredModels.length],
  );
  const refreshModels = useCallback(() => {
    for (const provider of providerIds) catalogSession.refresh(provider);
    setModelRefreshKey((key) => key + 1);
  }, [catalogSession, providerIds]);

  const switchModelTab = useCallback(() => {
    setModelTab((tab) => (tab === 'all' ? 'favorites' : 'all'));
    setModelSelectedIndex(0);
    setModelScrollOffset(0);
  }, []);

  const movePoolUp = useCallback(() => {
    if (phase !== 'reorder' || selection.selectedIndex <= 0) return;
    const index = selection.selectedIndex;
    setReorderList((current) => {
      const next = [...current];
      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
      return next;
    });
    selection.moveUp();
  }, [phase, selection, selection.selectedIndex]);

  const movePoolDown = useCallback(() => {
    if (phase !== 'reorder' || selection.selectedIndex >= reorderList.length - 1) return;
    const index = selection.selectedIndex;
    setReorderList((current) => {
      const next = [...current];
      [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
      return next;
    });
    selection.moveDown();
  }, [phase, reorderList.length, selection, selection.selectedIndex]);

  const saveReorder = useCallback(() => {
    if (phase !== 'reorder') return;
    setEntries(reorderList.map((entry) => ({ ...entry })));
    setReorderList([]);
    setDraftModified(true);
    setPhase('list');
    selection.setSelectedIndex(0);
  }, [phase, reorderList, selection.setSelectedIndex]);

  const goBack = useCallback(() => {
    setErrorMessage(null);
    setInput('');
    if (phase === 'list') return;
    if (phase === 'edit_model' || phase === 'edit_provider' || phase === 'edit_reasoning') {
      // Esc from the initial "add entry → model menu" step cancels the add
      // when nothing has been chosen yet.
      if (phase === 'edit_model' && draft?._isNew && !draft.model && !draftModified) {
        setDraft(null);
        setEditingIndex(null);
        setBrowsingProvider(null);
        setPhase('list');
        selection.setSelectedIndex(0);
        return;
      }
      setBrowsingProvider(null);
      setPhase('edit_fields');
      selection.setSelectedIndex(phase === 'edit_model' ? 0 : phase === 'edit_provider' ? 1 : 2);
    } else if (phase === 'edit_fields') {
      if (draftModified) {
        setDiscardFromPhase('edit_fields');
        setPhase('confirm_discard');
        selection.setSelectedIndex(1);
      } else {
        setDraft(null);
        setEditingIndex(null);
        setPhase('list');
        selection.setSelectedIndex(0);
      }
    } else if (phase === 'reorder') {
      setReorderList([]);
      setPhase('list');
      selection.setSelectedIndex(0);
    } else if (phase === 'confirm_delete') {
      setEditingIndex(null);
      setPhase('list');
      selection.setSelectedIndex(0);
    } else if (phase === 'confirm_discard') {
      if (discardFromPhase) setPhase(discardFromPhase);
      setDiscardFromPhase(null);
      selection.setSelectedIndex(0);
    }
  }, [discardFromPhase, draft, draftModified, phase, setInput, selection.setSelectedIndex]);

  const saveIntent = useCallback(
    (frameId: string): MenuEffect | null => {
      // Tier model pools persist plain model-id strings.
      const value = entryShape === 'models' ? entries.map((entry) => entry.model) : entries;
      const result =
        entryShape === 'models' ? tierPoolSchema.safeParse(value) : subagentPoolSchema(roleLabel).safeParse(entries);
      if (!result.success) {
        setErrorMessage(result.error.issues[0]?.message ?? `Invalid ${roleLabel.toLowerCase()} pool`);
        return null;
      }
      const persistence = settingsService.isRuntimeModifiable(settingKey as any) ? 'runtime' : 'restart';
      return {
        stack: { type: 'keep' },
        intent: {
          id: `apply-settings:${frameId}`,
          sourceFrameId: frameId,
          intent: {
            type: 'apply-settings',
            changes: [{ key: settingKey, value, persistence }],
          },
        },
      };
    },
    [entries, entryShape, roleLabel, settingKey, settingsService],
  );

  return {
    phase,
    entries,
    draft,
    selectedIndex: selection.selectedIndex,
    activeItems,
    selectedItem: activeItems[selection.selectedIndex],
    getSelectedItem: selection.getSelectedItem,
    errorMessage,
    fieldErrors,
    modelProvider,
    modelTab,
    modelQuery: input,
    filteredModels,
    modelLoading,
    modelError,
    modelSelectedIndex,
    modelScrollOffset,
    selectItem,
    goBack,
    requestDelete,
    selectModel,
    moveModelUp,
    moveModelDown,
    moveModelHome,
    moveModelEnd,
    pageModelUp,
    pageModelDown,
    refreshModels,
    switchModelTab,
    moveUp: selection.moveUp,
    moveDown: selection.moveDown,
    moveHome: selection.moveHome,
    moveEnd: selection.moveEnd,
    pageUp: selection.pageUp,
    pageDown: selection.pageDown,
    movePoolUp,
    movePoolDown,
    saveReorder,
    saveIntent,
  };
}
