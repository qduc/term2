/**
 * The one state primitive the chat shell builds on (docs/plans/web-client/web-shell-decomposition.md, section 4.1):
 * a value outside React that components read with `useStoreSelector` and a selector, so each re-renders only when
 * its slice changes. No React here.
 */

export interface ReadableStore<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export interface Store<T> extends ReadableStore<T> {
  /** Same reference in, no notification out. */
  set(next: T | ((current: T) => T)): void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * A value computed from other stores. `get()` recomputes only when an input's value changed identity, so the same
 * inputs give the same reference (what `useSyncExternalStore` requires). It tells its listeners whenever an input
 * does; a selector over it then decides whether anything changed.
 */
export function derivedStore<T>(inputs: readonly ReadableStore<unknown>[], compute: () => T): ReadableStore<T> {
  let seen: unknown[] | null = null;
  let value: T;
  return {
    get() {
      const current = inputs.map((input) => input.get());
      if (!seen || current.some((item, index) => !Object.is(item, seen![index]))) {
        seen = current;
        value = compute();
      }
      return value;
    },
    subscribe(listener) {
      const unsubscribes = inputs.map((input) => input.subscribe(listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}

/** Equal when both are the same value, or objects with the same keys whose values are each `Object.is`. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
