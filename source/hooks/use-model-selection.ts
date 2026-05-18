import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { fetchModels, filterModels, type ModelInfo } from '../services/model-service.js';
import { getProviderIds } from '../providers/index.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { parseModelProviderArg } from '../utils/model-provider-arg.js';
import { MODEL_CMD_TRIGGER, getModelSettingConfigForInput, MODEL_SETTING_CONFIGS } from '../utils/model-settings.js';

export const MODEL_TRIGGER = MODEL_SETTING_CONFIGS[0].trigger;
export { MODEL_CMD_TRIGGER };
export const MENTOR_TRIGGER = MODEL_SETTING_CONFIGS[1].trigger;
export const AUTO_APPROVE_MODEL_TRIGGER = MODEL_SETTING_CONFIGS[2].trigger;
export const EDIT_HEALING_MODEL_TRIGGER = MODEL_SETTING_CONFIGS[3].trigger;
export const SUBAGENT_EXPLORER_MODEL_TRIGGER = MODEL_SETTING_CONFIGS[4].trigger;
export const SUBAGENT_WORKER_MODEL_TRIGGER = MODEL_SETTING_CONFIGS[5].trigger;
export const SUBAGENT_RESEARCHER_MODEL_TRIGGER = MODEL_SETTING_CONFIGS[6].trigger;

export const useModelSelection = (
  deps: {
    loggingService: ILoggingService;
    settingsService: ISettingsService;
  },
  hasConversationHistory = false,
) => {
  const { loggingService, settingsService } = deps;
  const { mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex } = useInputContext();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [provider, setProvider] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const providerRef = useRef<string | null>(null);
  const failedProvidersRef = useRef<Set<string>>(new Set());
  const isInitialLoadRef = useRef(true);
  const loadRequestIdRef = useRef(0);
  const modelsByProviderRef = useRef<Map<string, ModelInfo[]>>(new Map());

  const isOpen = mode === 'model_selection';
  const modelSettingConfig = getModelSettingConfigForInput(input);
  const canSwitchProvider =
    Boolean(modelSettingConfig && modelSettingConfig.providerKey !== 'agent.provider') || !hasConversationHistory;

  const query = useMemo(() => {
    if (!isOpen || triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return parseModelProviderArg(input.slice(triggerIndex, end)).modelId;
  }, [isOpen, triggerIndex, input, cursorOffset]);

  const getInitialProvider = useCallback(() => {
    return modelSettingConfig
      ? settingsService.get<string>(modelSettingConfig.providerKey) ??
          settingsService.get<string>(modelSettingConfig.fallbackProviderKey ?? modelSettingConfig.providerKey)
      : settingsService.get<string>('agent.provider');
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
      failedProvidersRef.current.clear();
      isInitialLoadRef.current = true;
    }
  }, [isOpen, getInitialProvider, setCurrentProvider]);

  useEffect(() => {
    if (!isOpen || !provider) return;

    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () => requestId === loadRequestIdRef.current;
    const cachedModels = modelsByProviderRef.current.get(provider);

    const load = async () => {
      // If already marked as failed, don't try again in this session
      // unless it's the only one left (covered by logic below)
      if (failedProvidersRef.current.has(provider) && !isInitialLoadRef.current) {
        return;
      }

      setModels(cachedModels ?? []);
      setSelectedIndex(0);
      setScrollOffset(0);
      setLoading(!cachedModels);
      setError(null);

      try {
        const fetched = await fetchModels({ settingsService, loggingService }, provider);
        modelsByProviderRef.current.set(provider, fetched);
        if (!isCurrentRequest()) return;
        setModels(fetched);
        isInitialLoadRef.current = false;
      } catch (err) {
        if (!isCurrentRequest()) return;
        const message = err instanceof Error ? err.message : String(err);
        loggingService.warn(`Model selection fetch failed for ${provider}`, { error: message });

        failedProvidersRef.current.add(provider);
        setError(message);
      } finally {
        if (isCurrentRequest()) {
          setLoading(false);
        }
      }
    };

    load().catch((err) => {
      if (!isCurrentRequest()) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
    });
  }, [isOpen, provider, settingsService, loggingService]);

  const filteredModels = useMemo(() => {
    return filterModels(models, query);
  }, [models, query]);

  useEffect(() => {
    setSelectedIndex((prev) => {
      if (filteredModels.length === 0) return 0;
      return Math.min(prev, filteredModels.length - 1);
    });
  }, [filteredModels.length]);

  // Reset scroll to top when query changes (filtering)
  useEffect(() => {
    setScrollOffset(0);
  }, [query]);

  // Auto-scroll to keep selected item visible
  useEffect(() => {
    const maxHeight = 10;
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + maxHeight) {
      setScrollOffset(selectedIndex - maxHeight + 1);
    }
  }, [selectedIndex, scrollOffset]);

  const open = useCallback(
    (startIndex: number) => {
      if (mode === 'model_selection') return;
      setCurrentProvider(getInitialProvider());
      setMode('model_selection');
      setTriggerIndex(startIndex);
      setSelectedIndex(0);
      setScrollOffset(0);
    },
    [mode, getInitialProvider, setCurrentProvider, setMode, setTriggerIndex],
  );

  const close = useCallback(() => {
    if (mode === 'model_selection') {
      setMode('text');
      setTriggerIndex(null);
      setCurrentProvider(null);
      setSelectedIndex(0);
      setScrollOffset(0);
    }
  }, [mode, setCurrentProvider, setMode, setTriggerIndex]);

  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => {
      if (filteredModels.length === 0) return 0;
      return prev > 0 ? prev - 1 : filteredModels.length - 1;
    });
  }, [filteredModels.length]);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => {
      if (filteredModels.length === 0) return 0;
      return prev < filteredModels.length - 1 ? prev + 1 : 0;
    });
  }, [filteredModels.length]);

  const getSelectedItem = useCallback(() => {
    if (filteredModels.length === 0) return undefined;
    const safeIndex = Math.min(selectedIndex, filteredModels.length - 1);
    return filteredModels[safeIndex];
  }, [filteredModels, selectedIndex]);

  const toggleProvider = useCallback(
    (direction: 'next' | 'prev' = 'next') => {
      const allProviderIds = getProviderIds();

      // If no providers available, stay on current
      if (allProviderIds.length === 0) return;

      const currentProvider = providerRef.current || getInitialProvider() || allProviderIds[0];
      const currentIndex = allProviderIds.indexOf(currentProvider);
      const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex =
        direction === 'prev'
          ? (safeCurrentIndex - 1 + allProviderIds.length) % allProviderIds.length
          : (safeCurrentIndex + 1) % allProviderIds.length;
      const nextProvider = allProviderIds[nextIndex];
      const cachedModels = modelsByProviderRef.current.get(nextProvider);

      // If the user manually selects it, we should allow retrying it
      failedProvidersRef.current.delete(nextProvider);
      setModels(cachedModels ?? []);
      setSelectedIndex(0);
      setScrollOffset(0);
      setLoading(!cachedModels);
      setError(null);
      setCurrentProvider(nextProvider);
    },
    [getInitialProvider, setCurrentProvider],
  );

  return {
    isOpen,
    triggerIndex,
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
    getSelectedItem,
    toggleProvider,
    canSwitchProvider,
  };
};
