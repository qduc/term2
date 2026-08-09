import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { filterModels, type ModelInfo } from '../services/model-service.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { ModelCatalogSession } from '../services/models/model-catalog-session.js';
import { parseModelProviderArg } from '../utils/ai/model-provider-arg.js';
import { getModelSettingConfigForInput } from '../utils/ai/model-settings.js';
import {
  getProviderCredentialSettingKey,
  getProviderIdForCredentialSettingKey,
  resolveProviderCredentials,
} from '../utils/ai/provider-credentials.js';

export const useModelSelection = (deps: { loggingService: ILoggingService; settingsService: ISettingsService }) => {
  const { loggingService, settingsService } = deps;
  const { mode, input, cursorOffset, triggerIndex, controller } = useInputContext();
  const catalogSession = useMemo(
    () => new ModelCatalogSession({ settingsService, loggingService }),
    [settingsService, loggingService],
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
  const shouldPreselectRef = useRef(false);

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
      }
    });
    return unsubscribe;
  }, [settingsService]);

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
    return filterModels(models, query);
  }, [models, query]);

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
      const nextProvider = catalogSession.nextProvider(currentProvider, direction);
      if (!nextProvider) return;
      const cachedModels = catalogSession.getCached(nextProvider);

      // If the user manually selects it, we should allow retrying it
      shouldPreselectRef.current = true;
      setModels(cachedModels ?? []);
      setSelectedIndex(0);
      setScrollOffset(0);
      setLoading(!cachedModels);
      setError(null);
      setCurrentProvider(nextProvider);
    },
    [getInitialProvider, setCurrentProvider, catalogSession],
  );

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
    refresh,
    canSwitchProvider,
    modelSettingConfig,
    credentialRevision,
  };
};
