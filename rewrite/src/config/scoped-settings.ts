import { isDeepStrictEqual } from 'node:util';
import type { SettingKey, SettingValue, SettingsChange, SettingsScope, SettingsWriter } from './index.js';

export type SettingsWriteMode = 'persistent' | 'runtime';

/** Storage operations only: the owner validates/persists writes and throws on refusal. */
export interface SettingsStorage {
  read(key: string): SettingValue | undefined;
  write(key: SettingKey, value: SettingValue, mode: SettingsWriteMode): void;
  watch(listener: () => void): () => void;
}

/** A copied capability scope over storage, with isolated overlays and passive observers.
 * Exact-key reads implement SettingsWriter; path reads project authorized descendants.
 * Silent overlay replacement is reserved for an owner that performs its own refresh.
 */
export function createScopedSettings(
  storage: SettingsStorage,
  scope: SettingsScope,
  overrides: ReadonlyMap<SettingKey, SettingValue | undefined> = new Map(),
  writeMode: SettingsWriteMode = 'persistent',
) {
  const readable = new Set(scope.readable);
  const writable = new Set(scope.writable);
  // Each session owns its own copy. A caller can safely reuse or mutate its
  // input map after this point without changing another session's view.
  const sessionOverrides = new Map<SettingKey, SettingValue | undefined>(
    [...overrides].map(([key, value]) => [key, snapshot(value)]),
  );
  const watchers = new Set<{
    readonly listener: (change: SettingsChange) => void;
    readonly lastSeen: Map<SettingKey, SettingValue | undefined>;
  }>();
  const pathWatchers = new Set<{
    readonly listener: (keys: readonly SettingKey[]) => void;
    readonly lastSeen: Map<SettingKey, SettingValue | undefined>;
  }>();

  const beneath = (child: string, parent: string) => child.startsWith(`${parent}.`);
  const directlyAuthorized = (key: string) => [...readable].some((allowed) => key === allowed || beneath(key, allowed));
  const sourceGet = (key: string): SettingValue | undefined => {
    const authorized = directlyAuthorized(key);
    const descendants = [...readable].filter((allowed) => beneath(allowed, key));
    if (!authorized && descendants.length === 0) return undefined;
    let value: unknown = authorized ? snapshot(storage.read(key) as SettingValue | undefined) : undefined;
    const ancestors = [...sessionOverrides.entries()]
      .filter(([path]) => key === path || beneath(key, path))
      .sort(([left], [right]) => left.length - right.length);
    for (const [path, override] of ancestors) value = nestedValue(override, key.slice(path.length).replace(/^\./, ''));
    if (!authorized) {
      value = {};
      for (const path of descendants) {
        const child = sourceGet(path);
        if (child !== undefined) value = withNestedValue(value, path.slice(key.length + 1), child);
      }
    } else {
      const children = [...sessionOverrides.entries()]
        .filter(([path]) => beneath(path, key) && directlyAuthorized(path))
        .sort(([left], [right]) => left.length - right.length);
      for (const [path, override] of children) value = withNestedValue(value, path.slice(key.length + 1), override);
    }
    return snapshot(value as SettingValue | undefined);
  };
  const get = (key: SettingKey): SettingValue | undefined => (readable.has(key) ? sourceGet(key) : undefined);

  const notify = (watcher: {
    readonly listener: (change: SettingsChange) => void;
    readonly lastSeen: Map<SettingKey, SettingValue | undefined>;
  }): void => {
    for (const key of readable) {
      const previous = watcher.lastSeen.get(key);
      const next = snapshot(get(key));
      if (isDeepStrictEqual(previous, next)) continue;
      watcher.lastSeen.set(key, next);
      try {
        watcher.listener({ key, previous, next });
      } catch {
        /* Settings observers are passive. */
      }
    }
  };

  const watch = (listener: (change: SettingsChange) => void): (() => void) => {
    const lastSeen = new Map<SettingKey, SettingValue | undefined>();
    for (const key of readable) lastSeen.set(key, snapshot(get(key)));
    const watcher = { listener, lastSeen };
    watchers.add(watcher);
    const unsubscribeService = storage.watch(() => notify(watcher));
    return () => {
      watchers.delete(watcher);
      unsubscribeService();
    };
  };

  const notifyPaths = (watcher: {
    readonly listener: (keys: readonly SettingKey[]) => void;
    readonly lastSeen: Map<SettingKey, SettingValue | undefined>;
  }): void => {
    const changed: SettingKey[] = [];
    for (const key of readable) {
      const next = snapshot(get(key));
      if (isDeepStrictEqual(watcher.lastSeen.get(key), next)) continue;
      watcher.lastSeen.set(key, next);
      changed.push(key);
    }
    if (changed.length) {
      try {
        watcher.listener(changed);
      } catch {
        /* Path observers are passive. */
      }
    }
  };
  const observe = (listener: (keys: readonly SettingKey[]) => void): (() => void) => {
    const lastSeen = new Map<SettingKey, SettingValue | undefined>();
    for (const key of readable) lastSeen.set(key, snapshot(get(key)));
    const watcher = { listener, lastSeen };
    pathWatchers.add(watcher);
    const unsubscribe = storage.watch(() => notifyPaths(watcher));
    return () => {
      pathWatchers.delete(watcher);
      unsubscribe();
    };
  };

  const setSync = (key: SettingKey, value: SettingValue, mode: SettingsWriteMode = writeMode): void => {
    if (!writable.has(key)) throw new Error(`Setting '${key}' is not writable in this session`);
    if ([...sessionOverrides.keys()].some((path) => path === key || beneath(key, path))) {
      sessionOverrides.set(key, snapshot(value)!);
      for (const watcher of watchers) notify(watcher);
      for (const watcher of pathWatchers) notifyPaths(watcher);
      return;
    }

    storage.write(key, value, mode);
  };

  const settings: SettingsWriter = {
    get,
    watch,
    async set(key, value) {
      setSync(key, value);
    },
  };
  return {
    settings,
    readPath: sourceGet,
    write: setSync,
    observe,
    origin(key: string): 'hidden' | 'override' | 'storage' {
      if (!directlyAuthorized(key) && ![...readable].some((path) => beneath(path, key))) return 'hidden';
      return [...sessionOverrides.keys()].some(
        (path) => path === key || beneath(key, path) || (beneath(path, key) && directlyAuthorized(path)),
      )
        ? 'override'
        : 'storage';
    },
    replaceOverride(key: SettingKey, value: SettingValue | undefined): void {
      sessionOverrides.set(key, snapshot(value));
    },
  };
}

function snapshot(value: SettingValue | undefined): SettingValue | undefined {
  return value !== undefined && typeof value === 'object' && value !== null ? structuredClone(value) : value;
}

function nestedValue(value: unknown, path: string): unknown {
  if (!path) return value;
  return path
    .split('.')
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined,
      value,
    );
}

function withNestedValue(value: unknown, path: string, next: unknown): unknown {
  const copy: Record<string, unknown> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (structuredClone(value) as Record<string, unknown>)
      : {};
  const parts = path.split('.');
  let cursor = copy;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    cursor[part] =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = structuredClone(next);
  return copy;
}
