/**
 * In-memory TUI settings projection store backed by Client API v1.1
 * (`settings.get`/`settings.subscribe`/`settings.update` with `view: "tui"`).
 *
 * Exposes synchronous `ISettingsService` and `MenuSettingsService` views for
 * React render hooks (`useSetting`, ThemeContext, SkinContext, menus) while
 * keeping the daemon authoritative for persistence, defaults, and redaction.
 */
import { randomUUID } from 'node:crypto';
import {
  RUNTIME_MODIFIABLE_SETTINGS,
  type SettingKey,
  type SettingValue,
} from '../../config/settings/settings-schema.js';
import type { MenuSettingsService } from '../../clients/tui/integration.js';
import type { RemoteDirectHost } from '../../host/daemon/remote-direct-host.js';
import type { SettingsUpdateParamsV11 } from '../../protocol/client-api/client-api-schema.js';
import type { ISettingsService } from '../../shared/service-interfaces.js';

type SettingsChangeV11 = SettingsUpdateParamsV11['changes'][number];

export type DaemonSettingEntry = {
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly source: 'cli' | 'env' | 'config' | 'default';
  readonly startupOverride?: 'env' | 'cli';
  readonly runtimeModifiable: boolean;
};

export type DaemonProviderProjection = {
  readonly id: string;
  readonly label: string;
  readonly isCustom: boolean;
  readonly isActive: boolean;
  readonly hasCredentials: boolean;
  readonly isDisabled: boolean;
  readonly type?: string;
  readonly hasBaseUrl?: boolean;
  readonly baseUrl?: string;
};

export type DaemonOAuthAccountProjection = {
  readonly id: string;
  readonly label: string;
  readonly isSelected: boolean;
  readonly isInUse?: boolean;
};

export type DaemonTuiProjection = {
  readonly scope: 'global' | 'session';
  readonly sessionId?: string;
  readonly rebuilt?: boolean;
  readonly profileId?: string | null;
  readonly entries: Record<string, DaemonSettingEntry>;
  readonly providers: readonly DaemonProviderProjection[];
  readonly credentials: readonly { readonly id: string; readonly configured: boolean; readonly source?: string }[];
  readonly oauthAccounts: Readonly<Record<string, readonly DaemonOAuthAccountProjection[]>>;
  readonly sessionAccounts?: { readonly codex: string | null; readonly grok: string | null };
  readonly safety?: Record<string, unknown>;
};

type ScopeState = {
  readonly sessionId?: string;
  revision: string;
  projection: DaemonTuiProjection;
  readonly listeners: Set<(key?: string) => void>;
  unsubscribe?: () => Promise<void>;
  service: ISettingsService & MenuSettingsService & { reset(key: string): void };
};

function normalizeProvider(raw: Record<string, unknown>): DaemonProviderProjection {
  const credential =
    raw['credential'] && typeof raw['credential'] === 'object'
      ? (raw['credential'] as Record<string, unknown>)
      : undefined;
  return {
    id: String(raw['id'] ?? ''),
    label: String(raw['label'] ?? raw['id'] ?? ''),
    isCustom: raw['isCustom'] === true,
    isActive: raw['isActive'] === true || raw['active'] === true,
    hasCredentials: raw['hasCredentials'] === true || credential?.['configured'] === true,
    isDisabled: raw['isDisabled'] === true || raw['disabled'] === true,
    ...(typeof raw['type'] === 'string' ? { type: raw['type'] } : {}),
    ...(raw['hasBaseUrl'] === true ? { hasBaseUrl: true } : {}),
    ...(typeof raw['baseUrl'] === 'string' ? { baseUrl: raw['baseUrl'] } : {}),
  };
}

function parseProjection(raw: Record<string, unknown>): { revision: string; settings: DaemonTuiProjection } {
  const revision = typeof raw['revision'] === 'string' ? raw['revision'] : '';
  const rawSettings = raw['settings'] as Record<string, unknown> | undefined;
  if (!rawSettings || typeof rawSettings !== 'object') {
    return { revision, settings: rawSettings as unknown as DaemonTuiProjection };
  }
  const rawProviders = Array.isArray(rawSettings['providers']) ? rawSettings['providers'] : [];
  const providers = rawProviders
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map(normalizeProvider);
  const settings: DaemonTuiProjection = {
    ...(rawSettings as unknown as DaemonTuiProjection),
    providers,
  };
  return { revision, settings };
}

function createEmptyProjection(sessionId?: string): DaemonTuiProjection {
  return {
    scope: sessionId ? 'session' : 'global',
    ...(sessionId ? { sessionId, rebuilt: false, profileId: null } : {}),
    entries: {},
    providers: [],
    credentials: [],
    oauthAccounts: {},
  };
}

export class DaemonTuiSettingsStore {
  #host: RemoteDirectHost;
  readonly #global: ScopeState;
  readonly #sessions = new Map<string, ScopeState>();
  readonly #pendingOps = new Set<Promise<unknown>>();
  #writeQueue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(host: RemoteDirectHost) {
    this.#host = host;
    this.#global = this.#createScopeState(undefined);
  }

  get globalSettings(): ISettingsService & MenuSettingsService & { reset(key: string): void } {
    return this.#global.service;
  }

  replaceHost(host: RemoteDirectHost): void {
    this.#host = host;
  }

  trackPending(op: Promise<unknown>): void {
    this.#pendingOps.add(op);
    void op.finally(() => {
      this.#pendingOps.delete(op);
    });
  }

  async flush(): Promise<void> {
    await this.#writeQueue.catch(() => undefined);
    while (this.#pendingOps.size > 0) {
      await Promise.allSettled([...this.#pendingOps]);
      await this.#writeQueue.catch(() => undefined);
    }
  }

  async hydrateGlobal(): Promise<void> {
    await this.#hydrateScope(this.#global);
  }

  async hydrateSession(
    sessionId: string,
  ): Promise<ISettingsService & MenuSettingsService & { reset(key: string): void }> {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = this.#createScopeState(sessionId);
      this.#sessions.set(sessionId, state);
    }
    // Retire subscriptions for previously viewed sessions so only the active session streams updates.
    for (const [id, other] of this.#sessions) {
      if (id !== sessionId && other.unsubscribe) {
        const unsub = other.unsubscribe;
        other.unsubscribe = undefined;
        void unsub().catch(() => undefined);
      }
    }
    await this.#hydrateScope(state);
    return state.service;
  }

  liveSettings(sessionId: string): (ISettingsService & MenuSettingsService & { reset(key: string): void }) | null {
    return this.#sessions.get(sessionId)?.service ?? null;
  }

  sessionMeta(sessionId: string): {
    readonly rebuilt: boolean;
    readonly profileId: string | null;
    readonly sessionAccounts: { readonly codex: string | null; readonly grok: string | null };
  } {
    const proj = this.#sessions.get(sessionId)?.projection;
    return {
      rebuilt: proj?.rebuilt ?? false,
      profileId: proj?.profileId ?? null,
      sessionAccounts: proj?.sessionAccounts ?? { codex: null, grok: null },
    };
  }

  projection(sessionId?: string): DaemonTuiProjection {
    if (sessionId) return this.#sessions.get(sessionId)?.projection ?? this.#global.projection;
    return this.#global.projection;
  }

  async refresh(sessionId?: string): Promise<void> {
    const state = sessionId ? this.#sessions.get(sessionId) : this.#global;
    if (!state) return;
    const raw = await this.#host.readSettings({ ...(sessionId ? { sessionId } : {}), view: 'tui' });
    this.#applySnapshot(state, parseProjection(raw));
  }

  async updateSettings(input: {
    readonly sessionId?: string;
    readonly persist: boolean;
    readonly changes: readonly SettingsChangeV11[];
  }): Promise<Record<string, unknown>> {
    const task = this.#writeQueue.then(() => this.#runUpdate(input));
    this.#writeQueue = task.catch(() => undefined);
    return await task;
  }

  async close(): Promise<void> {
    await this.flush();
    this.#closed = true;
    const unsubs: Array<Promise<void>> = [];
    if (this.#global.unsubscribe) {
      unsubs.push(this.#global.unsubscribe().catch(() => undefined));
      this.#global.unsubscribe = undefined;
    }
    for (const state of this.#sessions.values()) {
      if (state.unsubscribe) {
        unsubs.push(state.unsubscribe().catch(() => undefined));
        state.unsubscribe = undefined;
      }
    }
    await Promise.all(unsubs);
  }

  async #runUpdate(input: {
    readonly sessionId?: string;
    readonly persist: boolean;
    readonly changes: readonly SettingsChangeV11[];
  }): Promise<Record<string, unknown>> {
    const state = input.sessionId ? this.#sessions.get(input.sessionId) ?? this.#global : this.#global;
    const requestId = `tui_${randomUUID()}`;
    const attempt = async (expectedRevision: string): Promise<Record<string, unknown>> => {
      const res = await this.#host.updateScopedSettings({
        expectedRevision,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        view: 'tui',
        persist: input.persist,
        requestId,
        changes: [...input.changes],
      });
      this.#applySnapshot(state, parseProjection(res));
      if (input.persist && state !== this.#global) {
        void this.refresh().catch(() => undefined);
      }
      return res;
    };
    try {
      return await attempt(state.revision);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'stale_revision') {
        await this.refresh(input.sessionId);
        return await attempt(state.revision);
      }
      throw error;
    }
  }

  async #hydrateScope(state: ScopeState): Promise<void> {
    if (state.unsubscribe) {
      const old = state.unsubscribe;
      state.unsubscribe = undefined;
      await old().catch(() => undefined);
    }
    const raw = await this.#host.readSettings({
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      view: 'tui',
    });
    this.#applySnapshot(state, parseProjection(raw));
    if (this.#closed) return;
    const sub = await this.#host.subscribeSettings(
      (frame) => {
        if (frame.event === 'settings.snapshot' || frame.event === 'settings.changed') {
          this.#applySnapshot(state, parseProjection(frame.payload));
        }
      },
      { ...(state.sessionId ? { sessionId: state.sessionId } : {}), view: 'tui' },
    );
    state.unsubscribe = sub.unsubscribe;
  }

  #applySnapshot(state: ScopeState, next: { revision: string; settings: DaemonTuiProjection }): void {
    if (!next.settings || typeof next.settings !== 'object') return;
    state.revision = next.revision;
    state.projection = next.settings;
    for (const listener of [...state.listeners]) {
      try {
        listener();
      } catch {
        // Keep listener notifications isolated.
      }
    }
  }

  #createScopeState(sessionId?: string): ScopeState {
    const state: ScopeState = {
      sessionId,
      revision: '',
      projection: createEmptyProjection(sessionId),
      listeners: new Set(),
      service: null as unknown as ScopeState['service'],
    };

    const readDynamic = (key: string): unknown => {
      const entry = state.projection.entries[key];
      if (entry !== undefined) return entry.value;
      const globalEntry = this.#global.projection.entries[key];
      if (globalEntry !== undefined) return globalEntry.value;
      return undefined;
    };

    const readDefault = (key: string): unknown => {
      const entry = state.projection.entries[key] ?? this.#global.projection.entries[key];
      return entry?.defaultValue;
    };

    const applyLocalOptimistic = (key: string, value: unknown): void => {
      const prev = state.projection.entries[key];
      state.projection = {
        ...state.projection,
        entries: {
          ...state.projection.entries,
          [key]: {
            value,
            defaultValue: prev?.defaultValue ?? readDefault(key),
            source: prev?.source ?? 'config',
            ...(prev?.startupOverride ? { startupOverride: prev.startupOverride } : {}),
            runtimeModifiable: prev?.runtimeModifiable ?? RUNTIME_MODIFIABLE_SETTINGS.has(key),
          },
        },
      };
      for (const listener of [...state.listeners]) {
        try {
          listener(key);
        } catch {
          // Keep listener notifications isolated.
        }
      }
    };

    const commitAsync = (key: string, value: unknown, persist: boolean): void => {
      applyLocalOptimistic(key, value);
      void this.updateSettings({
        ...(sessionId ? { sessionId } : {}),
        persist,
        changes: [{ key, value }],
      }).catch(() => {
        void this.refresh(sessionId).catch(() => undefined);
      });
    };

    const resetKey = (key: string): void => {
      applyLocalOptimistic(key, readDefault(key));
      void this.updateSettings({
        ...(sessionId ? { sessionId } : {}),
        persist: true,
        changes: [{ key, reset: true }],
      }).catch(() => {
        void this.refresh(sessionId).catch(() => undefined);
      });
    };

    state.service = {
      get<K extends SettingKey>(key: K): SettingValue<K> {
        return readDynamic(key) as SettingValue<K>;
      },
      getDynamic: readDynamic,
      getDefault: readDefault,
      getSource: (key: string) =>
        state.projection.entries[key]?.source ?? this.#global.projection.entries[key]?.source ?? 'default',
      getStartupOverride: (key: string) =>
        state.projection.entries[key]?.startupOverride ?? this.#global.projection.entries[key]?.startupOverride,
      isRuntimeModifiable: (key: string) =>
        state.projection.entries[key]?.runtimeModifiable ?? RUNTIME_MODIFIABLE_SETTINGS.has(key),
      set<K extends SettingKey>(key: K, value: SettingValue<K>, options?: { persist?: boolean }): void {
        commitAsync(key, value, options?.persist !== false);
      },
      setDynamic(key: string, value: unknown, options?: { persist?: boolean }): void {
        commitAsync(key, value, options?.persist !== false);
      },
      setPersistent<K extends SettingKey>(key: K, value: SettingValue<K>): void {
        commitAsync(key, value, true);
      },
      setPersistentDynamic(key: string, value: unknown): void {
        commitAsync(key, value, true);
      },
      reset: resetKey,
      onChange(listener: (key?: string) => void): () => void {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
    };
    return state;
  }
}
