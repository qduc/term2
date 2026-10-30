import type {
  SettingKey,
  SettingValue,
  SettingsChange,
  SettingsScope,
  SettingsSource,
  SettingsWriter,
} from '../index.js';
import { resolveSettingsDirectory } from '../../../../source/services/settings/settings-path.js';
import { SettingsService } from '../../../../source/services/settings/settings-service.js';

export type SettingsWriteMode = 'persistent' | 'runtime';

type LegacySettingsOptions = NonNullable<ConstructorParameters<typeof SettingsService>[0]>;

export type AdoptedSettingsOptions = LegacySettingsOptions & {
  readonly writeMode?: SettingsWriteMode;
};

export function createAdoptedSettings(options: AdoptedSettingsOptions = {}): {
  readonly service: SettingsService;
  readonly source: SettingsSource;
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
    const readable = new Set(scope.readable);
    const writable = new Set(scope.writable);
    // Each session owns its own copy. A caller can safely reuse or mutate its
    // input map after this point without changing another session's view.
    const sessionOverrides = new Map(overrides);
    const watchers = new Set<{
      readonly listener: (change: SettingsChange) => void;
      readonly lastSeen: Map<SettingKey, SettingValue | undefined>;
    }>();

    const get = (key: SettingKey): SettingValue | undefined => {
      if (!readable.has(key)) return undefined;
      if (sessionOverrides.has(key)) return sessionOverrides.get(key);
      return this.service.getDynamic(key) as SettingValue | undefined;
    };

    const notifyOverrideChange = (key: SettingKey, previous: SettingValue | undefined): void => {
      if (!readable.has(key)) return;
      const next = snapshot(get(key));
      for (const watcher of watchers) {
        const prior = watcher.lastSeen.has(key) ? watcher.lastSeen.get(key) : previous;
        watcher.lastSeen.set(key, next);
        try {
          watcher.listener({ key, previous: prior, next });
        } catch {
          // Match SettingsService.onChange: one observer cannot interrupt a write.
        }
      }
    };

    const watch = (listener: (change: SettingsChange) => void): (() => void) => {
      const lastSeen = new Map<SettingKey, SettingValue | undefined>();
      for (const key of readable) lastSeen.set(key, snapshot(get(key)));
      const watcher = { listener, lastSeen };
      watchers.add(watcher);
      const unsubscribeService = this.service.onChange((changedKey) => {
        const keys = changedKey === undefined ? readable : [changedKey as SettingKey];
        for (const key of keys) {
          if (!readable.has(key)) continue;
          const next = snapshot(get(key));
          // A session override masks its corresponding host value. Keep the
          // snapshot current without leaking a hidden host change to the session.
          if (sessionOverrides.has(key)) {
            lastSeen.set(key, next);
            continue;
          }
          const previous = lastSeen.get(key);
          lastSeen.set(key, next);
          try {
            listener({ key, previous, next });
          } catch {
            // Match SettingsService.onChange: one observer cannot interrupt a write.
          }
        }
      });
      return () => {
        watchers.delete(watcher);
        unsubscribeService();
      };
    };

    const set = async (key: SettingKey, value: SettingValue): Promise<void> => {
      if (!writable.has(key)) throw new Error(`Setting '${key}' is not writable in this session`);
      if (sessionOverrides.has(key)) {
        const previous = snapshot(get(key));
        sessionOverrides.set(key, value);
        notifyOverrideChange(key, previous);
        return;
      }

      if (this.writeMode === 'runtime') {
        this.service.setDynamic(key, value, { persist: false });
        return;
      }
      const result = this.service.setPersistentDynamic(key, value);
      if (result.status !== 'saved') {
        throw new Error(`Setting '${key}' was not persisted (${result.reason})`);
      }
    };

    return { get, watch, set };
  }
}

function snapshot(value: SettingValue | undefined): SettingValue | undefined {
  return value !== undefined && typeof value === 'object' && value !== null ? structuredClone(value) : value;
}
