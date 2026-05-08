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
  const failedProvidersRef = useRef<Set<string>>(new Set());
  const isInitialLoadRef = useRef(true);

  const isOpen = mode === 'model_selection';
  const modelSettingConfig = getModelSettingConfigForInput(input);
  const canSwitchProvider =
    Boolean(modelSettingConfig && modelSettingConfig.providerKey !== 'agent.provider') || !hasConversationHistory;

  const query = useMemo(() => {
    if (!isOpen || triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return parseModelProviderArg(input.slice(triggerIndex, end)).modelId;
  }, [isOpen, triggerIndex, input, cursorOffset]);

  useEffect(() => {
    if (isOpen) {
      const providerSetting = modelSettingConfig
        ? settingsService.get<string>(modelSettingConfig.providerKey) ??
          settingsService.get<string>(modelSettingConfig.fallbackProviderKey ?? modelSettingConfig.providerKey)
        : settingsService.get<string>('agent.provider');
      setProvider(providerSetting);
      failedProvidersRef.current.clear();
      isInitialLoadRef.current = true;
    }
  }, [isOpen, modelSettingConfig, settingsService]);

  useEffect(() => {
    if (!isOpen || !provider) return;

    const load = async () => {
      // If already marked as failed, don't try again in this session
      // unless it's the only one left (covered by logic below)
      if (failedProvidersRef.current.has(provider) && !isInitialLoadRef.current) {
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const fetched = await fetchModels({ settingsService, loggingService }, provider);
        setModels(fetched);
        isInitialLoadRef.current = false;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        loggingService.warn(`Model selection fetch failed for ${provider}`, { error: message });

        failedProvidersRef.current.add(provider);
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    load().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
    });
  }, [isOpen, provider]);

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
      setMode('model_selection');
      setTriggerIndex(startIndex);
      setSelectedIndex(0);
      setScrollOffset(0);
    },
    [mode, setMode, setTriggerIndex],
  );

  const close = useCallback(() => {
    if (mode === 'model_selection') {
      setMode('text');
      setTriggerIndex(null);
      setSelectedIndex(0);
      setScrollOffset(0);
    }
  }, [mode, setMode, setTriggerIndex]);

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

  const toggleProvider = useCallback(() => {
    const allProviderIds = getProviderIds();

    // If no providers available, stay on current
    if (allProviderIds.length === 0) return;

    setProvider((prev) => {
      const currentIndex = allProviderIds.indexOf(prev || allProviderIds[0]);
      const nextIndex = (currentIndex + 1) % allProviderIds.length;
      const nextProvider = allProviderIds[nextIndex];
      // If the user manually selects it, we should allow retrying it
      failedProvidersRef.current.delete(nextProvider);
      return nextProvider;
    });
  }, []);

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
