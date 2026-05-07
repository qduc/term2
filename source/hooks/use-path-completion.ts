import { useCallback, useEffect, useMemo, useState } from 'react';
import Fuse from 'fuse.js';
import { getWorkspaceEntries, refreshWorkspaceEntries, type PathEntry } from '../services/file-service.js';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import type { ILoggingService } from '../services/service-interfaces.js';

export type PathCompletionItem = PathEntry;

const MAX_RESULTS = 12;

export const usePathCompletion = (deps?: { loggingService?: ILoggingService }) => {
  const logger = deps?.loggingService;
  const { mode, setMode, input, triggerIndex, setTriggerIndex, cursorOffset } = useInputContext();

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
    loadEntries().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (logger) {
        logger.error('Failed to load workspace entries', {
          error: message,
        });
      } else {
        console.error('[use-path-completion] Failed to load workspace entries', message);
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
      .map((result) => result.item)
      .slice(0, MAX_RESULTS);
  }, [entries, fuse, query]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, getSelectedItem } = useSelection(filteredEntries);

  const open = useCallback(
    (startIndex: number, _initialQuery = '') => {
      // Preserve selection when already open to avoid resetting on re-renders
      if (mode === 'path_completion') return;
      setMode('path_completion');
      setTriggerIndex(startIndex);
      setSelectedIndex(0);
      // initialQuery is ignored because we derive it
    },
    [mode, setMode, setTriggerIndex, setSelectedIndex],
  );

  const close = useCallback(() => {
    if (mode === 'path_completion') {
      setMode('text');
      setTriggerIndex(null);
      setSelectedIndex(0);
    }
  }, [mode, setMode, setTriggerIndex, setSelectedIndex]);

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

  // updateQuery removed

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
    moveUp,
    moveDown,
    getSelectedItem,
    refresh,
  };
};
