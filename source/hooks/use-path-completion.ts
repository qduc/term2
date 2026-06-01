import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getWorkspaceEntries,
  getWorkspaceEntriesMeta,
  refreshWorkspaceEntries,
  type PathEntry,
  type WorkspaceEntriesMeta,
} from '../services/file-service.js';
import { filterPathEntries } from './path-completion-filter.js';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import type { ILoggingService } from '../services/service-interfaces.js';

export type PathCompletionItem = PathEntry;

const MAX_RESULTS = 100;

type UsePathCompletionDeps = {
  loggingService?: ILoggingService;
  getWorkspaceEntries?: typeof getWorkspaceEntries;
  refreshWorkspaceEntries?: typeof refreshWorkspaceEntries;
  getWorkspaceEntriesMeta?: typeof getWorkspaceEntriesMeta;
};

// Builds an accurate warning for whichever truncation actually occurred. The
// total-entry limit is the only cap on the workspace listing, so any warning
// must be specific to that cause.
export const buildWorkspaceLimitWarning = (
  meta: Pick<WorkspaceEntriesMeta, 'truncatedByTotalLimit' | 'limit'>,
): string | null => {
  if (meta.truncatedByTotalLimit) {
    return `Path completion is limited to ${meta.limit} entries because this repo is too large. Showing a best-effort breadth-first sample.`;
  }
  return null;
};

export const usePathCompletion = (deps?: UsePathCompletionDeps) => {
  const logger = deps?.loggingService;
  const loadWorkspaceEntries = deps?.getWorkspaceEntries ?? getWorkspaceEntries;
  const reloadWorkspaceEntries = deps?.refreshWorkspaceEntries ?? refreshWorkspaceEntries;
  const loadWorkspaceEntriesMeta = deps?.getWorkspaceEntriesMeta ?? getWorkspaceEntriesMeta;
  const { mode, setMode, input, triggerIndex, setTriggerIndex, cursorOffset } = useInputContext();

  // Logging is a side effect only; an unstable logger reference must not cause
  // workspace loading effects to re-run on every render.
  const loggerRef = useRef(logger);
  loggerRef.current = logger;

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
  const [warning, setWarning] = useState<string | null>(null);

  const syncWorkspaceWarning = useCallback((meta: WorkspaceEntriesMeta) => {
    const warningText = buildWorkspaceLimitWarning(meta);
    setWarning(warningText);

    if (!warningText) {
      return;
    }

    const details = {
      limit: meta.limit,
      totalEntries: meta.totalEntries,
      truncatedByTotalLimit: meta.truncatedByTotalLimit,
    };
    const currentLogger = loggerRef.current;
    if (currentLogger) {
      currentLogger.warn('Path completion truncated the workspace listing', details);
    } else {
      console.warn('[use-path-completion] Path completion truncated the workspace listing', details);
    }
  }, []);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const paths = await loadWorkspaceEntries();
      setEntries(paths);
      syncWorkspaceWarning(loadWorkspaceEntriesMeta());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setWarning(null);
    } finally {
      setLoading(false);
    }
  }, [loadWorkspaceEntries, loadWorkspaceEntriesMeta, syncWorkspaceWarning]);

  useEffect(() => {
    loadEntries().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const currentLogger = loggerRef.current;
      if (currentLogger) {
        currentLogger.error('Failed to load workspace entries', {
          error: message,
        });
      } else {
        console.error('[use-path-completion] Failed to load workspace entries', message);
      }
    });
  }, [loadEntries]);

  const filteredEntries = useMemo(() => {
    return filterPathEntries(entries, query, MAX_RESULTS);
  }, [entries, query]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredEntries);

  const [scrollOffset, setScrollOffset] = useState(0);

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const paths = await reloadWorkspaceEntries();
      setEntries(paths);
      syncWorkspaceWarning(loadWorkspaceEntriesMeta());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setWarning(null);
    } finally {
      setLoading(false);
    }
  }, [reloadWorkspaceEntries, loadWorkspaceEntriesMeta, syncWorkspaceWarning]);

  const open = useCallback(
    (startIndex: number, _initialQuery = '') => {
      // Preserve selection when already open to avoid resetting on re-renders
      if (mode === 'path_completion') return;
      setMode('path_completion');
      setTriggerIndex(startIndex);
      setSelectedIndex(0);
      setScrollOffset(0);
      // initialQuery is ignored because we derive it
      // Refresh in background to avoid stale entries; don't block open
      refresh().catch(() => {});
    },
    [mode, setMode, setTriggerIndex, setSelectedIndex, refresh],
  );

  const close = useCallback(() => {
    if (mode === 'path_completion') {
      setMode('text');
      setTriggerIndex(null);
      setSelectedIndex(0);
      setScrollOffset(0);
    }
  }, [mode, setMode, setTriggerIndex, setSelectedIndex]);

  // updateQuery removed

  return {
    isOpen,
    triggerIndex, // Still needed by consumers? Yes
    query,
    entries,
    filteredEntries,
    selectedIndex,
    scrollOffset,
    loading,
    error,
    warning,
    open,
    close,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    pageUp,
    pageDown,
    getSelectedItem,
    refresh,
  };
};
