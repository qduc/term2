import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { filterModels, type ModelInfo } from '../services/model-service.js';
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
  FAVORITES_TAB_ID,
  getFavoriteModelInfos,
  serializeFavorite,
  toggleFavoriteModel,
} from '../services/models/model-favorites.js';
import { getNicknameEntries, getNicknameLabels, setNicknameTarget } from '../services/models/model-nicknames.js';
import { SETTING_KEYS } from '../services/settings/settings-schema.js';

/**
 * Authoritative state of the Favorites tab's inline nickname editor. The
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

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [provider, setProvider] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const providerRef = useRef<string | null>(null);
  const isInitialLoadRef = useRef(true);
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
  const canSwitchProvider = true;

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

  const query = useMemo(() => {
    if (!isOpen) return '';
    if (isControllerOpen) return parseModelProviderArg(controllerFrame.binding.query).modelId;
    if (triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return parseModelProviderArg(input.slice(triggerIndex, end)).modelId;
  }, [isOpen, isControllerOpen, controllerFrame, triggerIndex, input, cursorOffset]);

  const getInitialProvider = useCallback(() => {
    // Favorites open first when any exist — the whole point is to be fast to
    // reach. Otherwise, fall back to whichever provider was already active.
    if (getFavoriteModelInfos(settingsService).length > 0) return FAVORITES_TAB_ID;
    const raw = modelSettingConfig
      ? settingsService.getDynamic(modelSettingConfig.providerKey) ??
        settingsService.getDynamic(modelSettingConfig.fallbackProviderKey ?? modelSettingConfig.providerKey)
      : settingsService.get('agent.provider');
    return typeof raw === 'string' ? raw : null;
  }, [modelSettingConfig, settingsService]);

  const setCurrentProvider = useCallback((nextProvider: string | null) => {
    providerRef.current = nextProvider;
    setProvider(nextProvider);
  }, []);

  useEffect(() => {
    if (isOpen) {
      if (providerRef.current === null) {
        setCurrentProvider(getInitialProvider());
      }
      catalogSession.begin();
      isInitialLoadRef.current = true;
      shouldPreselectRef.current = true;
    }
  }, [isOpen, getInitialProvider, setCurrentProvider, catalogSession]);

  useEffect(() => {
    if (!isOpen || !provider) return;

    // The Favorites pseudo-tab renders purely from settings via
    // favoriteModelInfos (see filteredModels below): no catalog fetch, no
    // credential check, nothing to load here.
    if (provider === FAVORITES_TAB_ID) {
      setLoading(false);
      setError(null);
      isInitialLoadRef.current = false;
      return;
    }

    const credentialResolution = resolveProviderCredentials(settingsService, provider);
    if (credentialResolution.required && !credentialResolution.configured) {
      const modelKey = modelSettingConfig ? modelSettingConfig.modelKey : 'agent.model';
      const configuredModel = settingsService.getDynamic(modelKey);
      const unavailableModels =
        typeof configuredModel === 'string' && configuredModel
          ? [
              {
                id: configuredModel,
                provider,
                unavailableReason: credentialResolution.unavailableReason ?? ('missing-credentials' as const),
              },
            ]
          : [];
      setModels(unavailableModels);
      setSelectedIndex(0);
      setScrollOffset(0);
      setLoading(false);
      setError(null);
      isInitialLoadRef.current = false;
      return;
    }

    const cachedModels = catalogSession.getCached(provider);

    const load = async () => {
      // If already marked as failed, don't try again in this session
      // unless it's the only one left (covered by logic below)
      if (!catalogSession.shouldRetry(provider, isInitialLoadRef.current)) {
        return;
      }

      setModels(cachedModels ?? []);
      setSelectedIndex(0);
      setScrollOffset(0);
      setLoading(!cachedModels);
      setError(null);
      let stale = false;

      try {
        const result = await catalogSession.load(provider);
        if (result.kind === 'stale') {
          stale = true;
          return;
        }
        setModels(result.models);
        isInitialLoadRef.current = false;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        if (!stale) setLoading(false);
      }
    };

    load().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
    });
  }, [isOpen, provider, catalogSession, refreshKey, credentialRevision, modelSettingConfig, settingsService]);

  const refresh = useCallback(() => {
    if (!isOpen || !provider) return;
    catalogSession.refresh(provider);
    setRefreshKey((k) => k + 1);
  }, [isOpen, provider, catalogSession]);

  const filteredModels = useMemo(() => {
    const source = provider === FAVORITES_TAB_ID ? favoriteModelInfos : models;
    return filterModels(source, query);
  }, [models, query, provider, favoriteModelInfos]);

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
      if (typeof currentModelValue === 'string' && currentModelValue) {
        const index = filteredModels.findIndex((m) => m.id === currentModelValue);
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

  // The editor is bound to one visible Favorites row; if that row leaves the
  // list — most commonly because ctrl+f un-favorited it while the editor was
  // open — the editor has nothing left to edit and closes with it.
  useEffect(() => {
    if (!nicknameDraft) return;
    const stillListed = filteredModels.some(
      (m) => m.provider.toLowerCase() === nicknameDraft.provider.toLowerCase() && m.id === nicknameDraft.modelId,
    );
    if (!stillListed) setNicknameDraft(null); // eslint-disable-line react-hooks/set-state-in-effect
  }, [filteredModels, nicknameDraft]);

  // Never leak an open editor into the next menu session.
  useEffect(() => {
    if (!isOpen && nicknameDraft) setNicknameDraft(null); // eslint-disable-line react-hooks/set-state-in-effect
  }, [isOpen, nicknameDraft]);

  const open = useCallback(
    (startIndex: number) => {
      if (mode === 'model_selection') return;
      setCurrentProvider(getInitialProvider());
      const editor = controller.getSnapshot().editor;
      controller.replaceText(editor.text, Math.max(editor.cursor, startIndex));
      shouldPreselectRef.current = true;
      setSelectedIndex(0);
      setScrollOffset(0);
    },
    [mode, controller, getInitialProvider, setCurrentProvider],
  );

  const close = useCallback(() => {
    if (mode === 'model_selection') {
      controller.close();
      setCurrentProvider(null);
      setSelectedIndex(0);
      setScrollOffset(0);
    }
  }, [mode, controller, setCurrentProvider]);

  const moveUp = useCallback(() => {
    shouldPreselectRef.current = false;
    setSelectedIndex((prev) => {
      if (filteredModels.length === 0) return 0;
      return prev > 0 ? prev - 1 : filteredModels.length - 1;
    });
  }, [filteredModels.length]);

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
    if (filteredModels.length === 0) return undefined;
    const safeIndex = Math.min(selectedIndex, filteredModels.length - 1);
    return filteredModels[safeIndex];
  }, [filteredModels, selectedIndex]);

  const toggleProvider = useCallback(
    (direction: 'next' | 'prev' = 'next') => {
      const currentProvider = providerRef.current || getInitialProvider() || null;
      // Favorites is a pinned-leftmost pseudo-provider ahead of every real
      // provider in the cycle, always reachable regardless of whether it's
      // currently empty (the empty state tells the user how to add one).
      const order = [FAVORITES_TAB_ID, ...orderedProviderIds(settingsService, getProviderIds())];
      if (order.length === 0) return;
      const currentIndex = order.indexOf(currentProvider ?? '');
      const nextProvider =
        currentIndex < 0
          ? direction === 'prev'
            ? order[order.length - 1]
            : order[0]
          : order[(currentIndex + (direction === 'prev' ? -1 : 1) + order.length) % order.length];
      if (!nextProvider) return;

      shouldPreselectRef.current = true;
      setSelectedIndex(0);
      setScrollOffset(0);
      setError(null);

      if (nextProvider === FAVORITES_TAB_ID) {
        setLoading(false);
        setCurrentProvider(nextProvider);
        return;
      }

      // If the user manually selects it, we should allow retrying it
      const cachedModels = catalogSession.getCached(nextProvider);
      setModels(cachedModels ?? []);
      setLoading(!cachedModels);
      setCurrentProvider(nextProvider);
    },
    [getInitialProvider, setCurrentProvider, catalogSession, settingsService],
  );

  const toggleFavorite = useCallback(() => {
    const selected = getSelectedItem();
    if (!selected) return;
    toggleFavoriteModel(settingsService, selected.provider, selected.id);
    setFavoritesRevision((revision) => revision + 1);
  }, [getSelectedItem, settingsService]);

  const startNicknameEdit = useCallback(() => {
    // Naming is a Favorites-tab affordance only: the filter is near-useless
    // on a 5-10 row list, so this tab can own its input row for naming
    // without contending with a filter that matters. Off this tab (or with
    // no row highlighted) the command is a deliberate no-op.
    if (providerRef.current !== FAVORITES_TAB_ID) return;
    const selected = getSelectedItem();
    if (!selected) return;
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
    provider,
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
    toggleProvider,
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
    canSwitchProvider,
    modelSettingConfig,
    credentialRevision,
  };
};
