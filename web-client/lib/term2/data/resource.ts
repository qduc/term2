/**
 * One fetched value with one meaning of loading, failed and refreshed, and one rule for a response that arrives
 * late (docs/plans/web-client/web-shell-decomposition.md, section 4.6). Checked by the generated property
 * `web.resource-latest-wins` (scripts/generated-verification/web-data.mjs). No React here.
 *
 * The rule: each request takes a number, and only the request started last may install its data or clear
 * `loading`/`refreshing`. A request for another `key` empties the value when it starts. `set` and `update` install
 * what the caller already has (a local insert) and do not cancel a request in flight. `replace` installs what is newer
 * than every request in flight (a write's answer): those still answer their callers but install nothing.
 */
import { createStore, type ReadableStore } from '../store';

export type ResourceState<T> = {
  readonly data: T;
  /** A load the screen should show as loading. */
  readonly loading: boolean;
  /** A refresh that keeps the current data on screen. */
  readonly refreshing: boolean;
  /** `data` came from the server, or from `set`/`update`, at least once for `key`. */
  readonly loaded: boolean;
  /** The last failure's message (empty when the error had none), cleared when a request starts. */
  readonly error: string | null;
  readonly key: string | null;
};

export interface Resource<T> extends ReadableStore<ResourceState<T>> {
  /** Fetches and shows loading. Resolves to the data, or null when it failed or a newer request replaced it. */
  load(key?: string | null): Promise<T | null>;
  /**
   * `load`, for a caller that must tell its own failure apart from being replaced: rejects only when this request
   * failed, and resolves to what it fetched even when a newer request replaced it (so nothing was installed).
   */
  loadOrFail(key?: string | null): Promise<T>;
  /** Fetches without the loading flag. Rejects on failure so the caller can word the error. */
  refresh(key?: string | null): Promise<T>;
  /** `load(key)` unless this key is loaded or loading. */
  ensure(key?: string | null): void;
  /** Installs data the caller already has; marks it loaded. A request in flight may still answer over it. */
  set(data: T): void;
  /**
   * Installs data newer than every request in flight (a write's answer), for the current key: those requests install
   * nothing when they answer (`load` resolves null), and `loading`, `refreshing` and `error` clear.
   */
  replace(data: T): void;
  update(change: (data: T) => T): void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error ?? ''));

export function createResource<T>(options: {
  initial: T;
  fetch: (key: string | null) => Promise<T>;
  /** The words `error` holds for a failed request. Default: the error's message. */
  describeError?: (error: unknown) => string;
}): Resource<T> {
  const describe = options.describeError ?? messageOf;
  const store = createStore<ResourceState<T>>({
    data: options.initial,
    loading: false,
    refreshing: false,
    loaded: false,
    error: null,
    key: null,
  });
  let latest = 0;

  const begin = (key: string | null, flag: 'loading' | 'refreshing') => {
    const request = ++latest;
    store.set((state) => ({
      ...(state.key === key ? state : { ...state, data: options.initial, loaded: false }),
      key,
      error: null,
      loading: flag === 'loading',
      refreshing: flag === 'refreshing',
    }));
    return request;
  };
  const settle = (request: number, change: Partial<ResourceState<T>>) => {
    if (request !== latest) return false;
    store.set((state) => ({ ...state, loading: false, refreshing: false, ...change }));
    return true;
  };

  const run = async (key: string | null, flag: 'loading' | 'refreshing'): Promise<T> => {
    const request = begin(key, flag);
    try {
      const data = await options.fetch(key);
      settle(request, { data, loaded: true });
      return data;
    } catch (error) {
      settle(request, { error: describe(error) });
      throw error;
    }
  };

  const resource: Resource<T> = {
    get: store.get,
    subscribe: store.subscribe,
    async load(key = null) {
      const request = latest + 1;
      try {
        const data = await run(key, 'loading');
        return request === latest ? data : null;
      } catch {
        return null;
      }
    },
    loadOrFail: (key = null) => run(key, 'loading'),
    refresh: (key = null) => run(key, 'refreshing'),
    ensure(key = null) {
      const state = store.get();
      if (state.key === key && (state.loaded || state.loading)) return;
      void resource.load(key);
    },
    set(data) {
      store.set((state) => ({ ...state, data, loaded: true }));
    },
    replace(data) {
      latest++;
      store.set((state) => ({ ...state, data, loaded: true, loading: false, refreshing: false, error: null }));
    },
    update(change) {
      store.set((state) => ({ ...state, data: change(state.data), loaded: true }));
    },
  };
  return resource;
}
