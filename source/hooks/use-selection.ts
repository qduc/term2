import { useCallback, useEffect, useReducer, useRef } from 'react';
import { clampIndex } from './settings-completion-logic.js';

export function useSelection<T>(items: T[], options?: { isInactive?: (item: T) => boolean }) {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const selectedIndexRef = useRef(0);

  const isInactive = useCallback(
    (item: T): boolean => {
      if (!item) return false;
      if (options?.isInactive) {
        return options.isInactive(item);
      }
      return !!(item as any).inactive;
    },
    // Only `options.isInactive` matters for the callback identity; the wrapping
    // options object should not cause a rebuild when it is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options?.isInactive],
  );

  // Clamp selected index and ensure it's not on an inactive item
  useEffect(() => {
    if (items.length === 0) {
      if (selectedIndexRef.current !== 0) {
        selectedIndexRef.current = 0;
        forceUpdate();
      }
      return;
    }
    let target = clampIndex(selectedIndexRef.current, items.length);
    if (isInactive(items[target])) {
      // Find nearest active item, scanning forward first, then backward
      let found = false;
      for (let i = target; i < items.length; i++) {
        if (!isInactive(items[i])) {
          target = i;
          found = true;
          break;
        }
      }
      if (!found) {
        for (let i = target - 1; i >= 0; i--) {
          if (!isInactive(items[i])) {
            target = i;
            found = true;
            break;
          }
        }
      }
    }
    if (target !== selectedIndexRef.current) {
      selectedIndexRef.current = target;
      forceUpdate();
    }
  }, [items, isInactive]);

  const setSelectedIndex = useCallback((index: number) => {
    selectedIndexRef.current = index;
    forceUpdate();
  }, []);

  const moveUp = useCallback(() => {
    if (items.length === 0) return;
    const start = selectedIndexRef.current;
    let next = start;
    do {
      next = next > 0 ? next - 1 : items.length - 1;
      if (!isInactive(items[next])) {
        selectedIndexRef.current = next;
        forceUpdate();
        return;
      }
    } while (next !== start);
  }, [items, isInactive]);

  const moveDown = useCallback(() => {
    if (items.length === 0) return;
    const start = selectedIndexRef.current;
    let next = start;
    do {
      next = next < items.length - 1 ? next + 1 : 0;
      if (!isInactive(items[next])) {
        selectedIndexRef.current = next;
        forceUpdate();
        return;
      }
    } while (next !== start);
  }, [items, isInactive]);

  const moveHome = useCallback(() => {
    if (items.length === 0) return;
    for (let i = 0; i < items.length; i++) {
      if (!isInactive(items[i])) {
        selectedIndexRef.current = i;
        forceUpdate();
        return;
      }
    }
  }, [items, isInactive]);

  const moveEnd = useCallback(() => {
    if (items.length === 0) return;
    for (let i = items.length - 1; i >= 0; i--) {
      if (!isInactive(items[i])) {
        selectedIndexRef.current = i;
        forceUpdate();
        return;
      }
    }
  }, [items, isInactive]);

  const pageUp = useCallback(() => {
    if (items.length === 0) return;
    let current = selectedIndexRef.current;
    let count = 0;
    let lastActive = current;
    while (current > 0 && count < 10) {
      current--;
      if (!isInactive(items[current])) {
        count++;
        lastActive = current;
      }
    }
    if (lastActive !== selectedIndexRef.current) {
      selectedIndexRef.current = lastActive;
      forceUpdate();
    }
  }, [items, isInactive]);

  const pageDown = useCallback(() => {
    if (items.length === 0) return;
    let current = selectedIndexRef.current;
    let count = 0;
    let lastActive = current;
    while (current < items.length - 1 && count < 10) {
      current++;
      if (!isInactive(items[current])) {
        count++;
        lastActive = current;
      }
    }
    if (lastActive !== selectedIndexRef.current) {
      selectedIndexRef.current = lastActive;
      forceUpdate();
    }
  }, [items, isInactive]);

  const getSelectedItem = useCallback((): T | undefined => {
    if (items.length === 0) return undefined;
    const safeIndex = clampIndex(selectedIndexRef.current, items.length);
    return items[safeIndex];
  }, [items]);

  return {
    get selectedIndex() {
      return selectedIndexRef.current;
    },
    setSelectedIndex,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    pageUp,
    pageDown,
    getSelectedItem,
  };
}
