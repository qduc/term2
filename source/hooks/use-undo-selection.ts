import { useCallback, useEffect, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';

export interface UndoItem {
  uiIndex: number;
  text: string;
}

type UndoSelectionResult = {
  isOpen: boolean;
  items: UndoItem[];
  selectedIndex: number;
  scrollOffset: number;
  open: (userMessages: UndoItem[]) => void;
  close: () => void;
  moveUp: () => void;
  moveDown: () => void;
  moveHome: () => void;
  moveEnd: () => void;
  pageUp: () => void;
  pageDown: () => void;
  getSelectedItem: () => UndoItem | undefined;
  confirmSelection: (onSelect: (item: UndoItem) => void) => void;
};

const MAX_VISIBLE_ITEMS = 10;

export const useUndoSelection = (): UndoSelectionResult => {
  const { mode, setMode } = useInputContext();

  const [items, setItems] = useState<UndoItem[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const isOpen = mode === 'undo_selection';

  const selection = useSelection(items);

  // Auto-cleanup when mode changes away from undo_selection (e.g., via Escape)
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (mode !== 'undo_selection') {
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
    (userMessages: UndoItem[]) => {
      setItems(userMessages);
      setMode('undo_selection');
      setScrollOffset(0);
      // Use setSelectedIndex directly because selection.moveEnd() would read the
      // stale items.length from its closure (items hasn't re-rendered yet).
      selection.setSelectedIndex(Math.max(0, userMessages.length - 1));
    },
    [setMode, selection],
  );

  const close = useCallback(() => {
    if (mode === 'undo_selection') {
      setMode('text');
      setItems([]);
      setScrollOffset(0);
    }
  }, [mode, setMode]);

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

  const getSelectedItem = useCallback((): UndoItem | undefined => {
    return selection.getSelectedItem();
  }, [selection]);

  const confirmSelection = useCallback(
    (onSelect: (item: UndoItem) => void) => {
      const item = selection.getSelectedItem();
      if (item) {
        close();
        onSelect(item);
      }
    },
    [selection, close],
  );

  return {
    isOpen,
    items,
    selectedIndex: selection.selectedIndex,
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
    confirmSelection,
  };
};
