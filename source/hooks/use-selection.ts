import { useCallback, useEffect, useState } from 'react';
import { clampIndex } from './use-settings-completion.js';

export function useSelection<T>(items: T[]) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Clamp selected index when items shrink
  useEffect(() => {
    setSelectedIndex((prev) => clampIndex(prev, items.length));
  }, [items.length]);

  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => {
      if (items.length === 0) return 0;
      return prev > 0 ? prev - 1 : items.length - 1;
    });
  }, [items.length]);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => {
      if (items.length === 0) return 0;
      return prev < items.length - 1 ? prev + 1 : 0;
    });
  }, [items.length]);

  const getSelectedItem = useCallback((): T | undefined => {
    if (items.length === 0) return undefined;
    const safeIndex = clampIndex(selectedIndex, items.length);
    return items[safeIndex];
  }, [items, selectedIndex]);

  return { selectedIndex, setSelectedIndex, moveUp, moveDown, getSelectedItem };
}
