import { useCallback, useEffect, useReducer, useRef } from 'react';
import { clampIndex } from './use-settings-completion.js';

export function useSelection<T>(items: T[]) {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const selectedIndexRef = useRef(0);

  // Clamp selected index when items shrink
  useEffect(() => {
    const clamped = clampIndex(selectedIndexRef.current, items.length);
    if (clamped !== selectedIndexRef.current) {
      selectedIndexRef.current = clamped;
      forceUpdate();
    }
  }, [items.length]);

  const setSelectedIndex = useCallback((index: number) => {
    selectedIndexRef.current = index;
    forceUpdate();
  }, []);

  const moveUp = useCallback(() => {
    if (items.length === 0) return;
    selectedIndexRef.current = selectedIndexRef.current > 0 ? selectedIndexRef.current - 1 : items.length - 1;
    forceUpdate();
  }, [items.length]);

  const moveDown = useCallback(() => {
    if (items.length === 0) return;
    selectedIndexRef.current = selectedIndexRef.current < items.length - 1 ? selectedIndexRef.current + 1 : 0;
    forceUpdate();
  }, [items.length]);

  const moveHome = useCallback(() => {
    selectedIndexRef.current = 0;
    forceUpdate();
  }, []);

  const moveEnd = useCallback(() => {
    selectedIndexRef.current = Math.max(0, items.length - 1);
    forceUpdate();
  }, [items.length]);

  const pageUp = useCallback(() => {
    selectedIndexRef.current = Math.max(0, selectedIndexRef.current - 10);
    forceUpdate();
  }, []);

  const pageDown = useCallback(() => {
    if (items.length === 0) return;
    selectedIndexRef.current = Math.min(items.length - 1, selectedIndexRef.current + 10);
    forceUpdate();
  }, [items.length]);

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
