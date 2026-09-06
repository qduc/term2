import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filterModels, type ModelInfo } from '../services/model-service.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import {
  ModelCatalogSession,
  orderedProviderIds,
  type ModelFetcher,
} from '../services/models/model-catalog-session.js';
import { getProviderIds } from '../providers/index.js';
import { resolveProviderCredentials } from '../utils/ai/provider-credentials.js';
import {
  FAVORITES_TAB_ID,
  getFavoriteModelInfos,
  serializeFavorite,
  toggleFavoriteModel,
} from '../services/models/model-favorites.js';
import { getNicknameEntries, getNicknameLabels, setNicknameTarget } from '../services/models/model-nicknames.js';
import type { NicknameDraftState } from './use-model-selection.js';

/**
 * Drives `ModelSelectionMenu` outside the composer's autocomplete machinery
 * (`useInputContext`/`MenuController`), for the pre-app picker host. It
 * mirrors `useModelSelection`'s catalog/favorites/nicknames/navigation
 * behavior — the same services, the same fuzzy filter, the same Favorites
 * tab — but owns its own query and provider state directly instead of
 * projecting them from a composer buffer, since there is no composer at
 * this point in the boot sequence.
 */
export const useStandaloneModelPicker = (deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  modelFetcher?: ModelFetcher;
  initialQuery?: string;
  /**
   * Provider tab to open on, ahead of the Favorites/agent.provider fallbacks:
   * the --model starter flow passes the provider of its top-ranked match, so
   * the seeded query matches in the catalog this picker loads first (it
   * fetches only the active tab's catalog). lockProvider still wins.
   */
  initialProvider?: string;
  /** When set, the tab is locked to this provider and cannot be switched. */
  lockProvider?: string;
}) => {
  const { loggingService, settingsService, modelFetcher, initialProvider, lockProvider } = deps;
  const catalogSession = useMemo(
    () => new ModelCatalogSession({ settingsService, loggingService, fetcher: modelFetcher }),
    [settingsService, loggingService, modelFetcher],
  );

  const [query, setQuery] = useState(deps.initialQuery ?? '');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const getInitialProvider = useCallback(() => {
    if (lockProvider) return lockProvider;
    if (initialProvider) return initialProvider;
    if (getFavoriteModelInfos(settingsService).length > 0) return FAVORITES_TAB_ID;
    const raw = settingsService.get('agent.provider');
    return typeof raw === 'string' ? raw : null;
  }, [lockProvider, initialProvider, settingsService]);
  const [provider, setProvider] = useState<string | null>(() => getInitialProvider());
  const [scrollOffset, setScrollOffset] = useState(0);
  const isInitialLoadRef = useRef(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [favoritesRevision, setFavoritesRevision] = useState(0);
  const [nicknamesRevision, setNicknamesRevision] = useState(0);
  const [nicknameDraft, setNicknameDraft] = useState<NicknameDraftState | null>(null);
  const shouldPreselectRef = useRef(true);

  const favoriteModelInfos = useMemo(
    () => getFavoriteModelInfos(settingsService),
    [settingsService, favoritesRevision],
  );
  const favoriteKeys = useMemo(
    () => new Set(favoriteModelInfos.map((m) => serializeFavorite(m.provider, m.id))),
    [favoriteModelInfos],
  );
  const nicknameLabels = useMemo(
    () => getNicknameLabels(settingsService),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsService, nicknamesRevision],
  );

  useEffect(() => {
    catalogSession.begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!provider) return;

    if (provider === FAVORITES_TAB_ID) {
      setLoading(false);
      setError(null);
      isInitialLoadRef.current = false;
      return;
    }

    const credentialResolution = resolveProviderCredentials(settingsService, provider);
    if (credentialResolution.required && !credentialResolution.configured) {
      const configuredModel = settingsService.getDynamic('agent.model');
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
      if (!catalogSession.shouldRetry(provider, isInitialLoadRef.current)) return;

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
  }, [provider, catalogSession, refreshKey, settingsService]);

  const refresh = useCallback(() => {
    if (!provider) return;
    catalogSession.refresh(provider);
    setRefreshKey((k) => k + 1);
  }, [provider, catalogSession]);

  const filteredModels = useMemo(() => {
    const source = provider === FAVORITES_TAB_ID ? favoriteModelInfos : models;
    return filterModels(source, query);
  }, [models, query, provider, favoriteModelInfos]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (filteredModels.length === 0) {
      setSelectedIndex(0);
      return;
    }

    if (shouldPreselectRef.current) {
      const currentModelValue = settingsService.getDynamic('agent.model');
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
  }, [filteredModels, loading, settingsService]);

  useEffect(() => {
    setScrollOffset(0); // eslint-disable-line react-hooks/set-state-in-effect
  }, [query]);

  useEffect(() => {
    const maxHeight = 10;
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex); // eslint-disable-line react-hooks/set-state-in-effect
    } else if (selectedIndex >= scrollOffset + maxHeight) {
      setScrollOffset(selectedIndex - maxHeight + 1);
    }
  }, [selectedIndex, scrollOffset]);

  useEffect(() => {
    if (!nicknameDraft) return;
    const stillListed = filteredModels.some(
      (m) => m.provider.toLowerCase() === nicknameDraft.provider.toLowerCase() && m.id === nicknameDraft.modelId,
    );
    if (!stillListed) setNicknameDraft(null); // eslint-disable-line react-hooks/set-state-in-effect
  }, [filteredModels, nicknameDraft]);

  const typeQuery = useCallback((text: string) => {
    if (!text) return;
    setQuery((prev) => prev + text);
  }, []);

  const backspaceQuery = useCallback(() => {
    setQuery((prev) => prev.slice(0, -1));
  }, []);

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

  const canSwitchProvider = !lockProvider;

  const toggleProvider = useCallback(
    (direction: 'next' | 'prev' = 'next') => {
      if (!canSwitchProvider) return;
      const currentProvider = provider ?? getInitialProvider() ?? null;
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
        setProvider(nextProvider);
        return;
      }

      const cachedModels = catalogSession.getCached(nextProvider);
      setModels(cachedModels ?? []);
      setLoading(!cachedModels);
      setProvider(nextProvider);
    },
    [canSwitchProvider, provider, getInitialProvider, catalogSession, settingsService],
  );

  const toggleFavorite = useCallback(() => {
    const selected = getSelectedItem();
    if (!selected) return;
    toggleFavoriteModel(settingsService, selected.provider, selected.id);
    setFavoritesRevision((revision) => revision + 1);
  }, [getSelectedItem, settingsService]);

  const startNicknameEdit = useCallback(() => {
    if (provider !== FAVORITES_TAB_ID) return;
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
  }, [provider, getSelectedItem, settingsService]);

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
      setNicknameDraft({ ...nicknameDraft, error: result.error });
      return;
    }
    setNicknameDraft(null);
    setNicknamesRevision((revision) => revision + 1);
  }, [nicknameDraft, settingsService]);

  const cancelNicknameDraft = useCallback(() => setNicknameDraft(null), []);

  return {
    query,
    typeQuery,
    backspaceQuery,
    loading,
    error,
    provider,
    filteredModels,
    selectedIndex,
    scrollOffset,
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
  };
};

export type StandaloneModelPickerState = ReturnType<typeof useStandaloneModelPicker>;
