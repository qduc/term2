'use client';

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { ReadableStore } from '../lib/term2/store';

/**
 * Reads one slice of a store. The component re-renders only when the selected value changes by `isEqual`; a
 * selector that builds an object must pass `shallowEqual` (lib/term2/store.ts), or it re-renders on every change.
 */
export function useStoreSelector<S, T>(
  store: ReadableStore<S>,
  selector: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ state: S; selector: (state: S) => T; selected: T } | null>(null);
  const getSelected = (): T => {
    const state = store.get();
    const cached = cache.current;
    if (cached && Object.is(cached.state, state) && cached.selector === selector) return cached.selected;
    const next = selector(state);
    const selected = cached && isEqual(cached.selected, next) ? cached.selected : next;
    cache.current = { state, selector, selected };
    return selected;
  };
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(subscribe, getSelected, getSelected);
}
