import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo } from '../services/model-service.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import {
  ModelCatalogSession,
  orderedProviderIds,
  type ModelFetcher,
} from '../services/models/model-catalog-session.js';
import { getProviderIds } from '../providers/index.js';
import { resolveProviderCredentials } from '../utils/ai/provider-credentials.js';
import {
  getFavoriteModelInfos,
  isFavoriteModel,
  serializeFavorite,
  toggleFavoriteModel,
} from '../services/models/model-favorites.js';
import { getNicknameEntries, getNicknameLabels, setNicknameTarget } from '../services/models/model-nicknames.js';
import { filterUnifiedModels, mergeUnifiedModels } from '../services/models/unified-model-catalog.js';
import type { NicknameDraftState } from './use-model-selection.js';

/**
 * Drives `ModelSelectionMenu` outside the composer's autocomplete machinery
 * (`useInputContext`/`MenuController`), for the pre-app picker host. It
 * mirrors `useModelSelection`'s catalog/favorites/nicknames/navigation
 * behavior — the same services and the same cross-provider fuzzy filter —
 * but owns its own query state directly instead of
 * projecting them from a composer buffer, since there is no composer at
 * this point in the boot sequence.
 */
export const useStandaloneModelPicker = (deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  modelFetcher?: ModelFetcher;
  initialQuery?: string;
  /**
   * Provider whose results should be loaded first. lockProvider still wins.
   */
  initialProvider?: string;
  /** When set, searches only this provider rather than the unified catalog. */
  lockProvider?: string;
}) => {
  const { loggingService, settingsService, modelFetcher, initialProvider, lockProvider } = deps;
  const catalogSession = useMemo(
    () => new ModelCatalogSession({ settingsService, loggingService, fetcher: modelFetcher }),
    [settingsService, loggingService, modelFetcher],
  );

  const [query, setQuery] = useState(deps.initialQuery ?? '');
  const [catalogs, setCatalogs] = useState<Map<string, ModelInfo[]>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const provider = lockProvider ?? null;
  const providerIds = useMemo(() => {
    if (lockProvider) return [lockProvider];
    const ordered = orderedProviderIds(settingsService, getProviderIds());
    if (!initialProvider || !ordered.includes(initialProvider)) return ordered;
    return [initialProvider, ...ordered.filter((id) => id !== initialProvider)];
  }, [initialProvider, lockProvider, settingsService]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [favoritesRevision, setFavoritesRevision] = useState(0);
  const [nicknamesRevision, setNicknamesRevision] = useState(0);
  const [nicknameDraft, setNicknameDraft] = useState<NicknameDraftState | null>(null);
  const shouldPreselectRef = useRef(true);

  const favoriteModelInfos = useMemo(
    () => getFavoriteModelInfos(settingsService),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const credentials = resolveProviderCredentials(settingsService, providerId);
      if (credentials.required && !credentials.configured) {
        const configuredModel = settingsService.getDynamic('agent.model');
        const unavailable =
          lockProvider && typeof configuredModel === 'string' && configuredModel
            ? [
                {
                  id: configuredModel,
                  provider: providerId,
                  unavailableReason: credentials.unavailableReason ?? ('missing-credentials' as const),
                },
              ]
            : [];
        setCatalogs((current) => new Map(current).set(providerId, unavailable));
        settle();
        continue;
      }

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
  }, [providerIds, catalogSession, refreshKey, settingsService, lockProvider]);

  const refresh = useCallback(() => {
    for (const providerId of providerIds) catalogSession.refresh(providerId);
    setRefreshKey((k) => k + 1);
  }, [providerIds, catalogSession]);

  const filteredModels = useMemo(() => {
    const configuredProvider = settingsService.getDynamic('agent.provider');
    const configuredModel = settingsService.getDynamic('agent.model');
    const unavailableConfigured =
      !lockProvider &&
      typeof configuredProvider === 'string' &&
      typeof configuredModel === 'string' &&
      configuredModel &&
      !providerIds.includes(configuredProvider)
        ? [
            {
              id: configuredModel,
              provider: configuredProvider,
              unavailableReason:
                resolveProviderCredentials(settingsService, configuredProvider).unavailableReason ??
                ('missing-credentials' as const),
            },
          ]
        : [];
    const source = mergeUnifiedModels(
      providerIds,
      catalogs,
      lockProvider ? [] : [...favoriteModelInfos, ...unavailableConfigured],
    );
    return filterUnifiedModels(source, query);
  }, [providerIds, catalogs, lockProvider, favoriteModelInfos, query, settingsService]);
  const filteredModelsRef = useRef(filteredModels);
  const selectedIndexRef = useRef(selectedIndex);
  filteredModelsRef.current = filteredModels;
  selectedIndexRef.current = selectedIndex;

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (filteredModels.length === 0) {
      setSelectedIndex(0);
      return;
    }

    if (shouldPreselectRef.current) {
      const currentModelValue = settingsService.getDynamic('agent.model');
      const currentProviderValue = settingsService.getDynamic('agent.provider');
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
    const stillListed =
      favoriteKeys.has(serializeFavorite(nicknameDraft.provider, nicknameDraft.modelId)) &&
      filteredModels.some(
        (m) => m.provider.toLowerCase() === nicknameDraft.provider.toLowerCase() && m.id === nicknameDraft.modelId,
      );
    if (!stillListed) setNicknameDraft(null); // eslint-disable-line react-hooks/set-state-in-effect
  }, [favoriteKeys, filteredModels, nicknameDraft]);

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
    warning,
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
    providerScope: lockProvider,
  };
};

export type StandaloneModelPickerState = ReturnType<typeof useStandaloneModelPicker>;
