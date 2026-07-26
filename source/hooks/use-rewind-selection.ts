import { useCallback, useEffect, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import type { RewindDisposition } from '../commands/rewind-command.js';

/**
 * A rewind candidate as the picker shows it: the turn plus what rewinding there
 * would discard. Mirrors `RewindTarget` from the conversation store, minus the
 * provider-history index the UI has no use for.
 */
export interface RewindItem {
  turnNumber: number;
  text: string;
  imageCount: number;
  discardedTurns: number;
  discardedReplies: number;
  discardedFiles: string[];
}

type RewindSelectionResult = {
  isOpen: boolean;
  items: RewindItem[];
  selectedIndex: number;
  scrollOffset: number;
  disposition: RewindDisposition;
  open: (items: RewindItem[], disposition: RewindDisposition) => void;
  close: () => void;
  toggleDisposition: () => void;
  moveUp: () => void;
  moveDown: () => void;
  moveHome: () => void;
  moveEnd: () => void;
  pageUp: () => void;
  pageDown: () => void;
  getSelectedItem: () => RewindItem | undefined;
  confirmSelection: (onSelect: (item: RewindItem, disposition: RewindDisposition) => void) => void;
};

const MAX_VISIBLE_ITEMS = 6;

export const useRewindSelection = (): RewindSelectionResult => {
  const { mode, setMode } = useInputContext();

  const [items, setItems] = useState<RewindItem[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [disposition, setDisposition] = useState<RewindDisposition>('edit');
  const isOpen = mode === 'rewind_selection';

  const selection = useSelection(items);

  // Auto-cleanup when mode changes away from rewind_selection (e.g., via Escape)
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (mode !== 'rewind_selection') {
      setItems([]);
      setScrollOffset(0);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [mode]);

  // Auto-scroll to keep selected item visible
  useEffect(() => {
    if (!isOpen) return;
    if (items.length <= MAX_VISIBLE_ITEMS) {
      if (scrollOffset !== 0) setScrollOffset(0); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }
    const selectedIndex = selection.selectedIndex;
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + MAX_VISIBLE_ITEMS) {
      setScrollOffset(selectedIndex - MAX_VISIBLE_ITEMS + 1);
    }
  }, [isOpen, items.length, selection.selectedIndex, scrollOffset]);

  const open = useCallback(
    (nextItems: RewindItem[], nextDisposition: RewindDisposition) => {
      setItems(nextItems);
      setDisposition(nextDisposition);
      setMode('rewind_selection');
      setScrollOffset(0);
      // Use setSelectedIndex directly because selection.moveEnd() would read the
      // stale items.length from its closure (items hasn't re-rendered yet).
      selection.setSelectedIndex(Math.max(0, nextItems.length - 1));
    },
    [setMode, selection],
  );

  const close = useCallback(() => {
    if (mode === 'rewind_selection') {
      setMode('text');
      setItems([]);
      setScrollOffset(0);
    }
  }, [mode, setMode]);

  const toggleDisposition = useCallback(() => {
    setDisposition((previous) => (previous === 'edit' ? 'resend' : 'edit'));
  }, []);

  const moveUp = useCallback(() => {
    selection.moveUp();
  }, [selection]);

  const moveDown = useCallback(() => {
    selection.moveDown();
  }, [selection]);

  const moveHome = useCallback(() => {
    selection.moveHome();
  }, [selection]);

  const moveEnd = useCallback(() => {
    selection.moveEnd();
  }, [selection]);

  const pageUp = useCallback(() => {
    selection.pageUp();
  }, [selection]);

  const pageDown = useCallback(() => {
    selection.pageDown();
  }, [selection]);

  const getSelectedItem = useCallback((): RewindItem | undefined => {
    return selection.getSelectedItem();
  }, [selection]);

  const confirmSelection = useCallback(
    (onSelect: (item: RewindItem, disposition: RewindDisposition) => void) => {
      const item = selection.getSelectedItem();
      if (item) {
        close();
        onSelect(item, disposition);
      }
    },
    [selection, close, disposition],
  );

  return {
    isOpen,
    items,
    selectedIndex: selection.selectedIndex,
    scrollOffset,
    disposition,
    open,
    close,
    toggleDisposition,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    pageUp,
    pageDown,
    getSelectedItem,
    confirmSelection,
  };
};
