import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { SETTING_KEYS } from '../services/settings/settings-service.js';
import { filterModels, type ModelInfo } from '../services/model-service.js';
import { ModelCatalogSession } from '../services/models/model-catalog-session.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { loadProviderItems, type ProviderSelectionItem } from '../providers/provider-service.js';
import { resolveProviderCredentials } from '../utils/ai/provider-credentials.js';
import { useSelection } from './use-selection.js';
import type { MenuEffect } from '../components/input/menu-types.js';

export const MENTOR_POOL_REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type MentorPoolReasoningEffort = (typeof MENTOR_POOL_REASONING_EFFORTS)[number];
export type MentorPoolEntry = {
  model: string;
  provider?: string;
  reasoningEffort?: MentorPoolReasoningEffort;
};
export type MentorPoolDraft = MentorPoolEntry & { _isNew?: boolean };
export type MentorPoolPhase =
  | 'list'
  | 'edit_fields'
  | 'edit_model'
  | 'edit_provider'
  | 'edit_reasoning'
  | 'confirm_delete'
  | 'confirm_discard'
  | 'reorder';

export type MentorPoolMenuItem =
  | { kind: 'entry'; entry: MentorPoolEntry; index: number; label: string }
  | { kind: 'action'; action: 'add' | 'reorder' | 'save' | 'cancel'; label: string; tone?: 'default' | 'destructive' }
  | { kind: 'field'; field: 'model' | 'provider' | 'reasoning'; label: string; detail: string }
  | { kind: 'provider'; id: string; label: string }
  | { kind: 'reasoning'; value: MentorPoolReasoningEffort; label: string }
  | { kind: 'reorder-entry'; index: number; label: string };

const mentorPoolEntrySchema = z.object({
  model: z.string().min(1, 'Model is required'),
  provider: z.string().min(1, 'Provider cannot be empty').optional(),
  reasoningEffort: z.enum(MENTOR_POOL_REASONING_EFFORTS).optional(),
});
const mentorPoolSchema = z.array(mentorPoolEntrySchema).max(8, 'Mentor pool cannot contain more than 8 entries');

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

const cloneEntries = (value: unknown): MentorPoolEntry[] => {
  const parsed = mentorPoolSchema.safeParse(value);
  return parsed.success ? parsed.data.map((entry) => ({ ...entry })) : [];
};

export function mergeMentorPoolModels({
  catalogModels,
  entries,
  provider,
  currentModel,
}: {
  catalogModels: readonly ModelInfo[];
  entries: readonly MentorPoolEntry[];
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
    if (entry.provider === undefined || entry.provider === provider) addSuggestion(entry.model, 'In mentor pool');
  }
  return [...suggestions, ...catalogModels];
}

export function resolveMentorPoolModelSelection(
  models: readonly ModelInfo[],
  selectedIndex: number,
  typedModel: string,
): string {
  return models[selectedIndex]?.id ?? typedModel.trim();
}

export function formatMentorPoolEntry(entry: MentorPoolEntry): string {
  const provider = entry.provider ? ` @ ${entry.provider}` : '';
  const effort = entry.reasoningEffort && entry.reasoningEffort !== 'default' ? ` (${entry.reasoningEffort})` : '';
  return `${entry.model}${provider}${effort}`;
}

export function useMentorPoolSelection(
  settingsService: SettingsService,
  active: boolean,
  loggingService?: ILoggingService,
) {
  const { input, setInput, replaceInput } = useInputContext();
  const [phase, setPhase] = useState<MentorPoolPhase>('list');
  const [entries, setEntries] = useState<MentorPoolEntry[]>([]);
  const [draft, setDraft] = useState<MentorPoolDraft | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [reorderList, setReorderList] = useState<MentorPoolEntry[]>([]);
  const [providerItems, setProviderItems] = useState<ProviderSelectionItem[]>([]);
  const [draftModified, setDraftModified] = useState(false);
  const [discardFromPhase, setDiscardFromPhase] = useState<MentorPoolPhase | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const catalogSession = useMemo(
    () => new ModelCatalogSession({ settingsService, loggingService: loggingService ?? noOpLoggingService }),
    [loggingService, settingsService],
  );
  const [catalogModels, setCatalogModels] = useState<ModelInfo[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0);
  const [modelScrollOffset, setModelScrollOffset] = useState(0);
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  const settingsServiceRef = useRef(settingsService);
  settingsServiceRef.current = settingsService;
  const modelProvider =
    draft?.provider ??
    settingsService.get(SETTING_KEYS.AGENT_MENTOR_PROVIDER) ??
    settingsService.get(SETTING_KEYS.AGENT_PROVIDER);
  const modelItems = useMemo(
    () =>
      mergeMentorPoolModels({
        catalogModels,
        entries,
        provider: modelProvider,
        currentModel: draft?.model ?? '',
      }),
    [catalogModels, draft?.model, entries, modelProvider],
  );
  const filteredModels = useMemo(() => filterModels(modelItems, input), [input, modelItems]);

  const activeItems = useMemo<MentorPoolMenuItem[]>(() => {
    if (phase === 'list') {
      const actions: MentorPoolMenuItem[] = [];
      if (entries.length < 8) actions.push({ kind: 'action', action: 'add', label: 'Add Entry' });
      actions.push({ kind: 'action', action: 'reorder', label: 'Reorder Entries' });
      actions.push({ kind: 'action', action: 'save', label: 'Save Changes' });
      return [
        ...entries.map((entry, index) => ({
          kind: 'entry' as const,
          entry,
          index,
          label: formatMentorPoolEntry(entry),
        })),
        ...actions,
      ];
    }
    if (phase === 'edit_fields') {
      if (!draft) return [];
      return [
        { kind: 'field', field: 'model', label: 'Model', detail: draft.model || '<empty>' },
        { kind: 'field', field: 'provider', label: 'Provider', detail: draft.provider || 'Inherit' },
        { kind: 'field', field: 'reasoning', label: 'Reasoning', detail: draft.reasoningEffort || 'Inherit' },
        { kind: 'action', action: 'save', label: 'Save Changes' },
        { kind: 'action', action: 'cancel', label: 'Cancel' },
      ];
    }
    if (phase === 'edit_provider') {
      return [
        { kind: 'provider', id: '', label: 'Inherit (use mentor provider)' },
        ...providerItems.map((provider) => ({ kind: 'provider' as const, id: provider.id, label: provider.label })),
      ];
    }
    if (phase === 'edit_reasoning') {
      return MENTOR_POOL_REASONING_EFFORTS.map((value) => ({ kind: 'reasoning' as const, value, label: value }));
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
      label: formatMentorPoolEntry(entry),
    }));
  }, [draft, entries, phase, providerItems, reorderList]);

  const selection = useSelection(activeItems);

  useEffect(() => {
    if (!active) return;
    const currentSettingsService = settingsServiceRef.current;
    const loaded = cloneEntries(currentSettingsService.get(SETTING_KEYS.AGENT_MENTOR_POOL));
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
  }, [active]);

  useEffect(() => {
    if (!active || phase !== 'edit_model') return;
    /* eslint-disable react-hooks/set-state-in-effect */
    const credentials = resolveProviderCredentials(settingsService, modelProvider);
    const cachedModels = catalogSession.getCached(modelProvider);
    setCatalogModels(cachedModels ?? []);
    setModelSelectedIndex(0);
    setModelScrollOffset(0);
    setModelError(null);

    if (credentials.required && !credentials.configured) {
      setModelLoading(false);
      return;
    }

    catalogSession.begin();
    let disposed = false;
    const load = async () => {
      setModelLoading(!cachedModels);
      try {
        const result = await catalogSession.load(modelProvider);
        if (disposed || result.kind === 'stale') return;
        setCatalogModels(result.models);
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
  }, [active, catalogSession, modelProvider, modelRefreshKey, phase, settingsService]);

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

  const openDraft = useCallback(
    (entry: MentorPoolEntry | null, index: number | null) => {
      setDraft(entry ? { ...entry, _isNew: false } : { model: '', _isNew: true });
      setEditingIndex(index);
      setDraftModified(false);
      setErrorMessage(null);
      setFieldErrors({});
      setPhase('edit_fields');
      setInput('');
    },
    [setInput],
  );

  const saveDraft = useCallback(() => {
    if (!draft) return;
    const result = mentorPoolEntrySchema.safeParse({
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
          setPhase('edit_model');
          replaceInput(draft.model);
        } else if (item.field === 'provider') {
          setPhase('edit_provider');
          selection.setSelectedIndex(
            draft.provider ? providerItems.findIndex((provider) => provider.id === draft.provider) + 1 : 0,
          );
          setInput('');
        } else {
          setPhase('edit_reasoning');
          selection.setSelectedIndex(
            Math.max(0, MENTOR_POOL_REASONING_EFFORTS.indexOf(draft.reasoningEffort ?? 'default')),
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
      setDraft({ ...draft, reasoningEffort: item.value === 'default' ? undefined : item.value });
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
    (value: string) => {
      if (phase !== 'edit_model' || !draft) return false;
      const model = value.trim();
      if (!model) {
        setFieldErrors({ model: 'Model is required' });
        setErrorMessage('Fix the highlighted fields before saving.');
        return false;
      }
      setDraft({ ...draft, model });
      setDraftModified(true);
      setFieldErrors({});
      setErrorMessage(null);
      setPhase('edit_fields');
      selection.setSelectedIndex(0);
      setInput('');
      return true;
    },
    [draft, phase, setInput, selection.setSelectedIndex],
  );

  const selectModel = useCallback(
    (typedValue: string) => saveModel(resolveMentorPoolModelSelection(filteredModels, modelSelectedIndex, typedValue)),
    [filteredModels, modelSelectedIndex, saveModel],
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
    catalogSession.refresh(modelProvider);
    setModelRefreshKey((key) => key + 1);
  }, [catalogSession, modelProvider]);

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
  }, [discardFromPhase, draftModified, phase, setInput, selection.setSelectedIndex]);

  const saveIntent = useCallback(
    (frameId: string): MenuEffect | null => {
      const result = mentorPoolSchema.safeParse(entries);
      if (!result.success) {
        setErrorMessage(result.error.issues[0]?.message ?? 'Invalid mentor pool');
        return null;
      }
      const persistence = settingsService.isRuntimeModifiable(SETTING_KEYS.AGENT_MENTOR_POOL) ? 'runtime' : 'restart';
      return {
        stack: { type: 'keep' },
        intent: {
          id: `apply-settings:${frameId}`,
          sourceFrameId: frameId,
          intent: {
            type: 'apply-settings',
            changes: [{ key: SETTING_KEYS.AGENT_MENTOR_POOL, value: result.data, persistence }],
          },
        },
      };
    },
    [entries, settingsService],
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
