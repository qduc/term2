import {useCallback, useEffect, useMemo, useState} from 'react';
import Fuse from 'fuse.js';
import {
    getWorkspaceEntries,
    refreshWorkspaceEntries,
    type PathEntry,
} from '../services/file-service.js';
import {useInputContext} from '../context/InputContext.js';
import type {ILoggingService} from '../services/service-interfaces.js';

export type PathCompletionItem = PathEntry;

const MAX_RESULTS = 12;

export const usePathCompletion = (deps?: {
    loggingService?: ILoggingService;
}) => {
    const logger = deps?.loggingService;
    const {mode, setMode, input, triggerIndex, setTriggerIndex, cursorOffset} =
        useInputContext();

    const isOpen = mode === 'path_completion';

    // Derive query from input + triggerIndex + cursorOffset
    const query = useMemo(() => {
        if (!isOpen || triggerIndex === null) return '';
        // Assuming trigger is '@', the query is after that
        // Safety check to ensure we don't slice weirdly
        if (triggerIndex >= input.length) return '';
        const end = Math.min(cursorOffset, input.length);
        // +1 to skip the '@' or whatever trigger char
        // Wait, InputBox passed the query. `findPathTrigger` logic:
        // if char === '@', query = text.slice(index + 1, cursor)
        return input.slice(triggerIndex + 1, end);
    }, [isOpen, triggerIndex, input, cursorOffset]);

    const [entries, setEntries] = useState<PathEntry[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadEntries = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const paths = await getWorkspaceEntries();
            setEntries(paths);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadEntries().catch(error => {
            const message =
                error instanceof Error ? error.message : String(error);
            if (logger) {
                logger.error('Failed to load workspace entries', {
                    error: message,
                });
            } else {
                console.error(
                    '[use-path-completion] Failed to load workspace entries',
                    message,
                );
            }
        });
    }, [loadEntries, logger]);

    const fuse = useMemo(() => {
        return new Fuse(entries, {
            keys: ['path'],
            threshold: 0.4,
            ignoreLocation: true,
        });
    }, [entries]);

    const filteredEntries = useMemo(() => {
        if (!query.trim()) {
            return entries.slice(0, MAX_RESULTS);
        }

        return fuse
            .search(query.trim())
            .map(result => result.item)
            .slice(0, MAX_RESULTS);
    }, [entries, fuse, query]);

    useEffect(() => {
        setSelectedIndex(prev => {
            if (filteredEntries.length === 0) {
                return 0;
            }
            return Math.min(prev, filteredEntries.length - 1);
        });
    }, [filteredEntries.length]);

    const open = useCallback(
        (startIndex: number, _initialQuery = '') => {
            // Preserve selection when already open to avoid resetting on re-renders
            if (mode === 'path_completion') return;
            setMode('path_completion');
            setTriggerIndex(startIndex);
            setSelectedIndex(0);
            // initialQuery is ignored because we derive it
        },
        [mode, setMode, setTriggerIndex],
    );

    const close = useCallback(() => {
        if (mode === 'path_completion') {
            setMode('text');
            setTriggerIndex(null);
            setSelectedIndex(0);
        }
    }, [mode, setMode, setTriggerIndex]);

    // updateQuery removed

    const moveUp = useCallback(() => {
        setSelectedIndex(prev => {
            if (filteredEntries.length === 0) {
                return 0;
            }
            return prev > 0 ? prev - 1 : filteredEntries.length - 1;
        });
    }, [filteredEntries.length]);

    const moveDown = useCallback(() => {
        setSelectedIndex(prev => {
            if (filteredEntries.length === 0) {
                return 0;
            }
            return prev < filteredEntries.length - 1 ? prev + 1 : 0;
        });
    }, [filteredEntries.length]);

    const getSelectedItem = useCallback(() => {
        if (filteredEntries.length === 0) {
            return undefined;
        }
        const safeIndex = Math.min(selectedIndex, filteredEntries.length - 1);
        return filteredEntries[safeIndex];
    }, [filteredEntries, selectedIndex]);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const paths = await refreshWorkspaceEntries();
            setEntries(paths);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
        } finally {
            setLoading(false);
        }
    }, []);

    return {
        isOpen,
        triggerIndex, // Still needed by consumers? Yes
        query,
        entries,
        filteredEntries,
        selectedIndex,
        loading,
        error,
        open,
        close,
        // updateQuery removed
        moveUp,
        moveDown,
        getSelectedItem,
        refresh,
    };
};
