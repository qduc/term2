import {useCallback, useEffect, useMemo, useState, useRef} from 'react';
import {useInputContext} from '../context/InputContext.js';
import {
    fetchModels,
    filterModels,
    type ModelInfo,
} from '../services/model-service.js';
import {getProviderIds} from '../providers/index.js';
import {getAvailableProviderIds} from '../utils/provider-credentials.js';
import type {
    ILoggingService,
    ISettingsService,
} from '../services/service-interfaces.js';

export const MODEL_TRIGGER = '/settings agent.model ';
export const MODEL_CMD_TRIGGER = '/model ';
export const MENTOR_TRIGGER = '/settings agent.mentorModel ';

export const useModelSelection = (
    deps: {
        loggingService: ILoggingService;
        settingsService: ISettingsService;
    },
    hasConversationHistory = false,
) => {
    const {loggingService, settingsService} = deps;
    const {mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex} =
        useInputContext();

    const [models, setModels] = useState<ModelInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [provider, setProvider] = useState<string | null>(null);
    const [scrollOffset, setScrollOffset] = useState(0);
    const failedProvidersRef = useRef<Set<string>>(new Set());
    const isInitialLoadRef = useRef(true);

    const isOpen = mode === 'model_selection';
    const canSwitchProvider = !hasConversationHistory;

    const query = useMemo(() => {
        if (!isOpen || triggerIndex === null) return '';
        const end = Math.min(cursorOffset, input.length);
        return input.slice(triggerIndex, end);
    }, [isOpen, triggerIndex, input, cursorOffset]);

    useEffect(() => {
        if (isOpen) {
            const providerSetting =
                settingsService.get<string>('agent.provider');
            setProvider(providerSetting);
            failedProvidersRef.current.clear();
            isInitialLoadRef.current = true;
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || !provider) return;

        const load = async () => {
            // If already marked as failed, don't try again in this session
            // unless it's the only one left (covered by logic below)
            if (
                failedProvidersRef.current.has(provider) &&
                !isInitialLoadRef.current
            ) {
                return;
            }

            setLoading(true);
            setError(null);

            try {
                const fetched = await fetchModels(
                    {settingsService, loggingService},
                    provider,
                );
                setModels(fetched);
                isInitialLoadRef.current = false;
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : String(err);
                loggingService.warn(
                    `Model selection fetch failed for ${provider}`,
                    {error: message},
                );

                failedProvidersRef.current.add(provider);

                const providerIds = getProviderIds();
                const available = getAvailableProviderIds(
                    settingsService,
                    providerIds,
                );

                // Find next available provider that hasn't failed yet
                const currentIndex = available.indexOf(provider);
                if (currentIndex !== -1 && available.length > 1) {
                    let nextIndex = (currentIndex + 1) % available.length;
                    let foundNext = false;

                    while (nextIndex !== currentIndex) {
                        const candidate = available[nextIndex]!;
                        if (!failedProvidersRef.current.has(candidate)) {
                            setProvider(candidate);
                            foundNext = true;
                            break;
                        }
                        nextIndex = (nextIndex + 1) % available.length;
                    }

                    if (!foundNext) {
                        // All available providers have been tried and failed
                        setError(message);
                    }
                } else {
                    // No other providers to try
                    setError(message);
                }
            } finally {
                setLoading(false);
            }
        };

        load().catch(err => {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            setLoading(false);
        });
    }, [isOpen, provider]);

    const filteredModels = useMemo(() => {
        return filterModels(models, query);
    }, [models, query]);

    useEffect(() => {
        setSelectedIndex(prev => {
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
        setSelectedIndex(prev => {
            if (filteredModels.length === 0) return 0;
            return prev > 0 ? prev - 1 : filteredModels.length - 1;
        });
    }, [filteredModels.length]);

    const moveDown = useCallback(() => {
        setSelectedIndex(prev => {
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
        const providerIds = getProviderIds();
        const availableProviders = getAvailableProviderIds(
            settingsService,
            providerIds,
        );

        // If no providers available, stay on current
        if (availableProviders.length === 0) return;

        setProvider(prev => {
            const currentIndex = availableProviders.indexOf(
                prev || availableProviders[0],
            );
            const nextIndex = (currentIndex + 1) % availableProviders.length;
            const nextProvider = availableProviders[nextIndex];
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
