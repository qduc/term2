import {useCallback, useEffect, useMemo, useState} from 'react';
import {useInputContext} from '../context/InputContext.js';
import {
    fetchModels,
    filterModels,
    type ModelInfo,
} from '../services/model-service.js';
import {loggingService} from '../services/logging-service.js';
import {settingsService} from '../services/settings-service.js';

export const MODEL_TRIGGER = '/settings agent.model ';
export const MODEL_CMD_TRIGGER = '/model ';
const MAX_RESULTS = 12;

export const useModelSelection = () => {
    const {mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex} =
        useInputContext();

    const [models, setModels] = useState<ModelInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [provider, setProvider] = useState<'openai' | 'openrouter' | null>(null);

    const isOpen = mode === 'model_selection';

    const query = useMemo(() => {
        if (!isOpen || triggerIndex === null) return '';
        const end = Math.min(cursorOffset, input.length);
        return input.slice(triggerIndex, end);
    }, [isOpen, triggerIndex, input, cursorOffset]);

    useEffect(() => {
        if (!isOpen) return;

        const load = async () => {
            setLoading(true);
            setError(null);
            const providerSetting = settingsService.get<'openai' | 'openrouter'>(
                'agent.provider',
            );
            setProvider(providerSetting);

            try {
                const fetched = await fetchModels(providerSetting);
                setModels(fetched);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setError(message);
                loggingService.warn('Model selection fetch failed', {error: message});
            } finally {
                setLoading(false);
            }
        };

        load().catch(err => {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            setLoading(false);
        });
    }, [isOpen]);

    const filteredModels = useMemo(() => {
        return filterModels(models, query, MAX_RESULTS);
    }, [models, query]);

    useEffect(() => {
        setSelectedIndex(prev => {
            if (filteredModels.length === 0) return 0;
            return Math.min(prev, filteredModels.length - 1);
        });
    }, [filteredModels.length]);

    const open = useCallback((startIndex: number) => {
        if (mode === 'model_selection') return;
        setMode('model_selection');
        setTriggerIndex(startIndex);
        setSelectedIndex(0);
    }, [mode, setMode, setTriggerIndex]);

    const close = useCallback(() => {
        if (mode === 'model_selection') {
            setMode('text');
            setTriggerIndex(null);
            setSelectedIndex(0);
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

    return {
        isOpen,
        triggerIndex,
        query,
        loading,
        error,
        provider,
        filteredModels,
        selectedIndex,
        open,
        close,
        moveUp,
        moveDown,
        getSelectedItem,
    };
};
