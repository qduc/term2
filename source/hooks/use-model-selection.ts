import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useInputContext } from '../context/InputContext.js';
import type { ModelInfo } from '../services/model-service.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import {
  ModelCatalogSession,
  orderedProviderIds,
  type ModelFetcher,
} from '../services/models/model-catalog-session.js';
import { getProviderIds } from '../providers/index.js';
import { parseModelProviderArg } from '../utils/ai/model-provider-arg.js';
import { getModelSettingConfigForInput } from '../utils/ai/model-settings.js';
import {
  getProviderCredentialSettingKey,
  getProviderIdForCredentialSettingKey,
  resolveProviderCredentials,
} from '../utils/ai/provider-credentials.js';
import {
  getFavoriteModelInfos,
  isFavoriteModel,
  serializeFavorite,
  toggleFavoriteModel,
} from '../services/models/model-favorites.js';
import { getNicknameEntries, getNicknameLabels, setNicknameTarget } from '../services/models/model-nicknames.js';
import { SETTING_KEYS } from '../services/settings/settings-schema.js';
import { filterUnifiedModels, mergeUnifiedModels } from '../services/models/unified-model-catalog.js';

type ModelTab = 'favorites' | 'all';

/**
 * Authoritative state of a favorited row's inline nickname editor. The
 * draft is bound to one row identity (provider + model id) and owns its own
 * text buffer — the filter query is never borrowed for naming, so cancelling
 * restores the previous filter text and cursor by construction.
 */
export type NicknameDraftState = Readonly<{
  provider: string;
  modelId: string;
  text: string;
  error: string | null;
}>;

export const useModelSelection = (deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  modelFetcher?: ModelFetcher;
}) => {
  const { loggingService, settingsService, modelFetcher } = deps;
  const { mode, input, cursorOffset, triggerIndex, controller } = useInputContext();
  const catalogSession = useMemo(
    () => new ModelCatalogSession({ settingsService, loggingService, fetcher: modelFetcher }),
    [settingsService, loggingService, modelFetcher],
  );

  const [catalogs, setCatalogs] = useState<Map<string, ModelInfo[]>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [modelTab, setModelTab] = useState<ModelTab>('all');
  const provider = null;
  const [scrollOffset, setScrollOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [favoritesRevision, setFavoritesRevision] = useState(0);
  const [nicknamesRevision, setNicknamesRevision] = useState(0);
  const [nicknameDraft, setNicknameDraft] = useState<NicknameDraftState | null>(null);
  const shouldPreselectRef = useRef(false);

  // Favorites render purely from settings: no catalog fetch, no credential
  // check. Recomputed whenever a toggle (or an external settings change)
  // bumps favoritesRevision.
  const favoriteModelInfos = useMemo(
    () => getFavoriteModelInfos(settingsService),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsService, favoritesRevision],
  );
  const favoriteKeys = useMemo(
    () => new Set(favoriteModelInfos.map((m) => serializeFavorite(m.provider, m.id))),
    [favoriteModelInfos],
  );

  // Nicknames render purely from settings, like favorites; recomputed when a
  // commit (or an external settings change) bumps nicknamesRevision.
  const nicknameLabels = useMemo(
    () => getNicknameLabels(settingsService),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsService, nicknamesRevision],
  );

  const controllerFrame = controller.getSnapshot().stack.at(-1);
  const isControllerOpen = controllerFrame?.kind === 'model';
  const isOpen = isControllerOpen || mode === 'model_selection';
  // getModelSettingConfigForInput reads the raw composer text directly, which
  // is authoritative whether or not the model graph is controller-owned.
  const modelSettingConfig = getModelSettingConfigForInput(input);
  const providerIds = useMemo(
    () => orderedProviderIds(settingsService, getProviderIds()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsService, credentialRevision],
  );
  const unavailableConfiguredModels = useMemo(() => {
    const modelKey = modelSettingConfig ? modelSettingConfig.modelKey : 'agent.model';
    const providerKey = modelSettingConfig ? modelSettingConfig.providerKey : 'agent.provider';
    const configuredModel = settingsService.getDynamic(modelKey);
    const configuredProvider = settingsService.getDynamic(providerKey);
    if (
      typeof configuredModel !== 'string' ||
      !configuredModel ||
      typeof configuredProvider !== 'string' ||
      providerIds.includes(configuredProvider)
    ) {
      return [];
    }
    const credentials = resolveProviderCredentials(settingsService, configuredProvider);
    return [
      {
        id: configuredModel,
        provider: configuredProvider,
        unavailableReason: credentials.unavailableReason ?? ('missing-credentials' as const),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSettingConfig, providerIds, settingsService, credentialRevision]);

  useEffect(() => {
    const unsubscribe = settingsService.onChange?.((changedKey) => {
      if (
        !changedKey ||
        changedKey === getProviderCredentialSettingKey('openai') ||
        changedKey === getProviderCredentialSettingKey('openrouter')
      ) {
        const providerId = getProviderIdForCredentialSettingKey(changedKey);
        if (providerId) catalogSession.invalidate(providerId);
        else catalogSession.clear();
        setCredentialRevision((revision) => revision + 1);
      } else if (changedKey === 'providers') {
        catalogSession.clear();
        setCredentialRevision((revision) => revision + 1);
      } else if (changedKey === SETTING_KEYS.AGENT_FAVORITE_MODELS) {
        setFavoritesRevision((revision) => revision + 1);
      } else if (changedKey === SETTING_KEYS.AGENT_MODEL_NICKNAMES) {
        setNicknamesRevision((revision) => revision + 1);
      }
    });
    return unsubscribe;
  }, [settingsService, catalogSession]);

  // While the model graph is controller-owned, the binding is the source of
  // truth for both the query and the replacement start. Keep the legacy
  // triggerIndex projection for callers that still use this hook directly.
  const activeTriggerIndex = isControllerOpen ? controllerFrame.binding.replacement.start : triggerIndex;

  const parsedQuery = useMemo(() => {
    if (!isOpen) return { modelId: '', provider: undefined };
    if (isControllerOpen) return parseModelProviderArg(controllerFrame.binding.query);
    if (triggerIndex === null) return { modelId: '', provider: undefined };
    const end = Math.min(cursorOffset, input.length);
    return parseModelProviderArg(input.slice(triggerIndex, end));
  }, [isOpen, isControllerOpen, controllerFrame, triggerIndex, input, cursorOffset]);
  const query = parsedQuery.modelId;

  useEffect(() => {
    if (isOpen) {
      catalogSession.begin();
      shouldPreselectRef.current = true;
    }
  }, [isOpen, catalogSession]);

  useEffect(() => {
    if (!isOpen) return;
    let disposed = false;
    let remaining = providerIds.length;
    const failures: string[] = [];
    setCatalogs(new Map()); // eslint-disable-line react-hooks/set-state-in-effect
    setSelectedIndex(0);
    setScrollOffset(0);
    setError(null);
    setWarning(null);
    setLoading(remaining > 0);

    const settle = () => {
      remaining -= 1;
      if (!disposed && remaining === 0) {
        setLoading(false);
        setWarning(failures.length > 0 ? `Some providers failed: ${failures.join(', ')}` : null);
      }
    };
    for (const providerId of providerIds) {
      catalogSession
        .load(providerId)
        .then((result) => {
          if (disposed || result.kind === 'stale') return;
          const models = result.models.map((model) => ({ ...model, provider: model.provider || providerId }));
          setCatalogs((current) => new Map(current).set(providerId, models));
        })
        .catch(() => {
          failures.push(providerId);
        })
        .finally(settle);
    }
    return () => {
      disposed = true;
    };
  }, [isOpen, providerIds, catalogSession, refreshKey]);

  const refresh = useCallback(() => {
    if (!isOpen) return;
    for (const providerId of providerIds) catalogSession.refresh(providerId);
    setRefreshKey((k) => k + 1);
  }, [isOpen, providerIds, catalogSession]);

  const filteredModels = useMemo(() => {
    const source = mergeUnifiedModels(providerIds, catalogs, [...favoriteModelInfos, ...unavailableConfiguredModels]);
    const tabModels =
      modelTab === 'favorites'
        ? source.filter((model) => favoriteKeys.has(serializeFavorite(model.provider, model.id)))
        : source;
    return filterUnifiedModels(tabModels, query, parsedQuery.provider);
  }, [
    providerIds,
    catalogs,
    favoriteModelInfos,
    unavailableConfiguredModels,
    favoriteKeys,
    modelTab,
    query,
    parsedQuery.provider,
  ]);
  const filteredModelsRef = useRef(filteredModels);
  const selectedIndexRef = useRef(selectedIndex);
  filteredModelsRef.current = filteredModels;
  selectedIndexRef.current = selectedIndex;

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    // Synchronize selectedIndex with filteredModels: clamp to bounds and,
    // when opening or switching provider, preselect the current model.
    if (filteredModels.length === 0) {
      setSelectedIndex(0);
      return;
    }

    if (shouldPreselectRef.current) {
      const modelKey = modelSettingConfig ? modelSettingConfig.modelKey : 'agent.model';
      const currentModelValue = settingsService.getDynamic(modelKey);
      const providerKey = modelSettingConfig ? modelSettingConfig.providerKey : 'agent.provider';
      const currentProviderValue = settingsService.getDynamic(providerKey);
      if (typeof currentModelValue === 'string' && currentModelValue) {
        const index = filteredModels.findIndex(
          (m) =>
            m.id === currentModelValue &&
            (typeof currentProviderValue !== 'string' || m.provider === currentProviderValue),
        );
        if (index >= 0) {
          setSelectedIndex(index);
          shouldPreselectRef.current = false;
          return;
        }
      }
      if (!loading) {
        shouldPreselectRef.current = false;
      }
    }

    setSelectedIndex((prev) => Math.min(prev, filteredModels.length - 1));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [filteredModels, loading, modelSettingConfig, settingsService]);

  // Reset scroll to top when query changes (filtering)
  useEffect(() => {
    setScrollOffset(0); // eslint-disable-line react-hooks/set-state-in-effect
  }, [query]);

  // Auto-scroll to keep selected item visible
  useEffect(() => {
    const maxHeight = 10;
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex); // eslint-disable-line react-hooks/set-state-in-effect
    } else if (selectedIndex >= scrollOffset + maxHeight) {
      setScrollOffset(selectedIndex - maxHeight + 1);
    }
  }, [selectedIndex, scrollOffset]);

  // The editor is bound to one visible favorite row.
  useEffect(() => {
    if (!nicknameDraft) return;
    const stillListed =
      favoriteKeys.has(serializeFavorite(nicknameDraft.provider, nicknameDraft.modelId)) &&
      filteredModels.some(
        (m) => m.provider.toLowerCase() === nicknameDraft.provider.toLowerCase() && m.id === nicknameDraft.modelId,
      );
    if (!stillListed) setNicknameDraft(null); // eslint-disable-line react-hooks/set-state-in-effect
  }, [favoriteKeys, filteredModels, nicknameDraft]);

  // Never leak an open editor into the next menu session.
  useEffect(() => {
    if (!isOpen && nicknameDraft) setNicknameDraft(null); // eslint-disable-line react-hooks/set-state-in-effect
  }, [isOpen, nicknameDraft]);

  const open = useCallback(
    (startIndex: number) => {
      if (mode === 'model_selection') return;
      const editor = controller.getSnapshot().editor;
      controller.replaceText(editor.text, Math.max(editor.cursor, startIndex));
      shouldPreselectRef.current = true;
      setSelectedIndex(0);
      setScrollOffset(0);
    },
    [mode, controller],
  );

  const close = useCallback(() => {
    if (mode === 'model_selection') {
      controller.close();
      setSelectedIndex(0);
      setScrollOffset(0);
    }
  }, [mode, controller]);

  const moveUp = useCallback(() => {
    shouldPreselectRef.current = false;
    setSelectedIndex((prev) => {
      if (filteredModels.length === 0) return 0;
      return prev > 0 ? prev - 1 : filteredModels.length - 1;
    });
  }, [filteredModels.length]);

  const switchModelTab = useCallback(() => {
    shouldPreselectRef.current = false;
    setModelTab((tab) => (tab === 'all' ? 'favorites' : 'all'));
    setSelectedIndex(0);
    setScrollOffset(0);
  }, []);

  const moveDown = useCallback(() => {
    shouldPreselectRef.current = false;
    setSelectedIndex((prev) => {
      if (filteredModels.length === 0) return 0;
      return prev < filteredModels.length - 1 ? prev + 1 : 0;
    });
  }, [filteredModels.length]);

  const moveHome = useCallback(() => {
    shouldPreselectRef.current = false;
    setSelectedIndex(0);
  }, []);

  const moveEnd = useCallback(() => {
    shouldPreselectRef.current = false;
    setSelectedIndex(Math.max(0, filteredModels.length - 1));
  }, [filteredModels.length]);

  const pageUp = useCallback(() => {
    shouldPreselectRef.current = false;
    setSelectedIndex((prev) => Math.max(0, prev - 10));
  }, []);

  const pageDown = useCallback(() => {
    shouldPreselectRef.current = false;
    setSelectedIndex((prev) => (filteredModels.length === 0 ? 0 : Math.min(filteredModels.length - 1, prev + 10)));
  }, [filteredModels.length]);

  const getSelectedItem = useCallback(() => {
    const currentModels = filteredModelsRef.current;
    if (currentModels.length === 0) return undefined;
    const safeIndex = Math.min(selectedIndexRef.current, currentModels.length - 1);
    return currentModels[safeIndex];
  }, []);

  const toggleFavorite = useCallback(() => {
    const selected = getSelectedItem();
    if (!selected) return;
    toggleFavoriteModel(settingsService, selected.provider, selected.id);
    setFavoritesRevision((revision) => revision + 1);
  }, [getSelectedItem, settingsService]);

  const startNicknameEdit = useCallback(() => {
    const selected = getSelectedItem();
    if (!selected) return;
    if (!isFavoriteModel(settingsService, selected.provider, selected.id)) return;
    const existing = getNicknameEntries(settingsService).find(
      (entry) => entry.provider.toLowerCase() === selected.provider.toLowerCase() && entry.modelId === selected.id,
    );
    setNicknameDraft({
      provider: selected.provider,
      modelId: selected.id,
      text: existing?.nickname ?? '',
      error: null,
    });
  }, [getSelectedItem, settingsService]);

  // The draft keeps its cursor at the end of the text: it names one row, so
  // mid-string cursor movement (and the arrows that would provide it) is not
  // part of this editor.
  const typeNicknameDraft = useCallback((text: string) => {
    if (!text) return;
    setNicknameDraft((draft) => (draft ? { ...draft, text: draft.text + text, error: null } : draft));
  }, []);

  const backspaceNicknameDraft = useCallback(() => {
    setNicknameDraft((draft) => (draft ? { ...draft, text: draft.text.slice(0, -1), error: null } : draft));
  }, []);

  const commitNicknameDraft = useCallback(() => {
    if (!nicknameDraft) return;
    const result = setNicknameTarget(
      settingsService,
      nicknameDraft.text,
      { provider: nicknameDraft.provider, modelId: nicknameDraft.modelId },
      { providerIds: getProviderIds() },
    );
    if (!result.ok) {
      // Rejected input keeps the user in the editor with the reason shown.
      setNicknameDraft({ ...nicknameDraft, error: result.error });
      return;
    }
    setNicknameDraft(null);
    setNicknamesRevision((revision) => revision + 1);
  }, [nicknameDraft, settingsService]);

  const cancelNicknameDraft = useCallback(() => setNicknameDraft(null), []);

  return {
    isOpen,
    triggerIndex: activeTriggerIndex, // Compatibility projection for legacy callers
    query,
    loading,
    error,
    warning,
    provider,
    modelTab,
    switchModelTab,
    filteredModels,
    selectedIndex,
    scrollOffset,
    open,
    close,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    pageUp,
    pageDown,
    getSelectedItem,
    toggleFavorite,
    favoriteKeys,
    nicknameDraft,
    nicknameLabels,
    startNicknameEdit,
    typeNicknameDraft,
    backspaceNicknameDraft,
    commitNicknameDraft,
    cancelNicknameDraft,
    refresh,
    modelSettingConfig,
    credentialRevision,
  };
};
