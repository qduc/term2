import type {
  SettingKey,
  SettingValue,
  SettingsChange,
  SettingsScope,
  SettingsSource,
  SettingsReader,
  SettingsWriter,
} from '../index.js';
import { resolveSettingsDirectory } from '../../../../source/services/settings/settings-path.js';
import { SettingsService } from '../../../../source/services/settings/settings-service.js';
import type { ISettingsService } from '../../../../source/services/service-interfaces.js';
import { isDeepStrictEqual } from 'node:util';

export type SettingsWriteMode = 'persistent' | 'runtime';

type LegacySettingsOptions = NonNullable<ConstructorParameters<typeof SettingsService>[0]>;

export type AdoptedSettingsOptions = LegacySettingsOptions & {
  readonly writeMode?: SettingsWriteMode;
};

const pairedServices = new WeakMap<SettingsReader, ISettingsService>();
export function isAdoptedSettingsPair(settings: SettingsReader, service: ISettingsService): boolean {
  return pairedServices.get(settings) === service;
}

export function createAdoptedSettings(options: AdoptedSettingsOptions = {}): {
  readonly service: SettingsService;
  readonly source: AdoptedSettingsSource;
} {
  const { writeMode = 'persistent', ...serviceOptions } = options;
  const service = new SettingsService({
    ...serviceOptions,
    // Match the old CLI's XDG_STATE_HOME / platform / home directory behavior.
    settingsDir: serviceOptions.settingsDir ?? resolveSettingsDirectory(),
  });
  return { service, source: new AdoptedSettingsSource(service, writeMode) };
}

/** Bridges the rewrite config contract to the existing settings owner. */
export class AdoptedSettingsSource implements SettingsSource {
  constructor(
    private readonly service: SettingsService,
    private readonly writeMode: SettingsWriteMode = 'persistent',
  ) {}

  forSession(scope: SettingsScope, overrides: ReadonlyMap<SettingKey, SettingValue> = new Map()): SettingsWriter {
    return this.forSessionBinding(scope, overrides).settings;
  }

  forSessionBinding(
    scope: SettingsScope,
    overrides: ReadonlyMap<SettingKey, SettingValue> = new Map(),
  ): {
    readonly settings: SettingsWriter;
    readonly service: ISettingsService;
  } {
    const readable = new Set(scope.readable);
    const writable = new Set(scope.writable);
    // Each session owns its own copy. A caller can safely reuse or mutate its
    // input map after this point without changing another session's view.
    const sessionOverrides = new Map([...overrides].map(([key, value]) => [key, snapshot(value)!]));
    const watchers = new Set<{
      readonly listener: (change: SettingsChange) => void;
      readonly lastSeen: Map<SettingKey, SettingValue | undefined>;
    }>();
    const sourceWatchers = new Set<{
      readonly listener: (key?: string) => void;
      readonly lastSeen: Map<SettingKey, SettingValue | undefined>;
    }>();

    const beneath = (child: string, parent: string) => child.startsWith(`${parent}.`);
    const directlyAuthorized = (key: string) =>
      [...readable].some((allowed) => key === allowed || beneath(key, allowed));
    const sourceGet = (key: string): SettingValue | undefined => {
      const authorized = directlyAuthorized(key);
      const descendants = [...readable].filter((allowed) => beneath(allowed, key));
      if (!authorized && descendants.length === 0) return undefined;
      let value: unknown = authorized ? snapshot(this.service.getDynamic(key) as SettingValue | undefined) : undefined;
      const ancestors = [...sessionOverrides.entries()]
        .filter(([path]) => key === path || beneath(key, path))
        .sort(([left], [right]) => left.length - right.length);
      for (const [path, override] of ancestors)
        value = nestedValue(override, key.slice(path.length).replace(/^\./, ''));
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
          /* Source settings observers are passive. */
        }
      }
    };

    const watch = (listener: (change: SettingsChange) => void): (() => void) => {
      const lastSeen = new Map<SettingKey, SettingValue | undefined>();
      for (const key of readable) lastSeen.set(key, snapshot(get(key)));
      const watcher = { listener, lastSeen };
      watchers.add(watcher);
      const unsubscribeService = this.service.onChange(() => notify(watcher));
      return () => {
        watchers.delete(watcher);
        unsubscribeService();
      };
    };

    const notifySource = (watcher: {
      readonly listener: (key?: string) => void;
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
          watcher.listener(changed.length === 1 ? changed[0] : undefined);
        } catch {
          /* Source observers are passive. */
        }
      }
    };
    const watchSource = (listener: (key?: string) => void): (() => void) => {
      const lastSeen = new Map<SettingKey, SettingValue | undefined>();
      for (const key of readable) lastSeen.set(key, snapshot(get(key)));
      const watcher = { listener, lastSeen };
      sourceWatchers.add(watcher);
      const unsubscribe = this.service.onChange(() => notifySource(watcher));
      return () => {
        sourceWatchers.delete(watcher);
        unsubscribe();
      };
    };

    const setSync = (key: SettingKey, value: SettingValue, mode: SettingsWriteMode = this.writeMode): void => {
      if (!writable.has(key)) throw new Error(`Setting '${key}' is not writable in this session`);
      if ([...sessionOverrides.keys()].some((path) => path === key || beneath(key, path))) {
        sessionOverrides.set(key, snapshot(value)!);
        for (const watcher of watchers) notify(watcher);
        for (const watcher of sourceWatchers) notifySource(watcher);
        return;
      }

      if (mode === 'runtime') {
        this.service.setDynamic(key, value, { persist: false });
        return;
      }
      const result = this.service.setPersistentDynamic(key, value);
      if (result.status !== 'saved') {
        throw new Error(`Setting '${key}' was not persisted (${result.reason})`);
      }
    };

    const settings: SettingsWriter = {
      get,
      watch,
      async set(key, value) {
        setSync(key, value);
      },
    };
    const service = {
      get: (key: string) => sourceGet(key),
      getDynamic: (key: string) => sourceGet(key),
      getSource: (key: string) =>
        !directlyAuthorized(key) && ![...readable].some((path) => beneath(path, key))
          ? ('default' as const)
          : [...sessionOverrides.keys()].some(
              (path) => path === key || beneath(key, path) || (beneath(path, key) && directlyAuthorized(path)),
            )
          ? ('cli' as const)
          : this.service.getSource(key as never),
      set: (key: string, value: SettingValue, options?: { persist?: boolean }) =>
        setSync(key as SettingKey, value, options?.persist === false ? 'runtime' : this.writeMode),
      setDynamic: (key: string, value: SettingValue, options?: { persist?: boolean }) =>
        setSync(key as SettingKey, value, options?.persist === false ? 'runtime' : this.writeMode),
      setPersistent: (key: string, value: SettingValue) => setSync(key as SettingKey, value, 'persistent'),
      setPersistentDynamic: (key: string, value: SettingValue) => setSync(key as SettingKey, value, 'persistent'),
      onChange: watchSource,
    } as ISettingsService;
    pairedServices.set(settings, service);
    return { settings, service };
  }
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
