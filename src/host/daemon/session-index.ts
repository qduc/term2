/**
 * Lightweight in-memory session metadata and live-status index powering `session.list`
 * and `session.list.subscribe` without N+1 `host.connect()` hydration (Client API §5.2).
 */
import { randomUUID } from 'node:crypto';
import type { DirectBinding, DirectSessionStore } from '../../session/facade-types.js';
import type { WireModel, WireStatus } from '../../protocol/wire.js';
import type {
  ClientApiSessionListItem,
  SessionListRemoveEvent,
  SessionListSnapshotEvent,
  SessionListUpsertEvent,
} from '../../protocol/client-api/client-api-schema.js';
import type { DirectHostLifecycleEvent, Principal } from '../in-process-direct-types.js';
import { deriveSnapshotSummary } from '../server-projection.js';
import { ServerHttpError } from '../server-errors.js';

export type SessionIndexRecord = {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly binding?: DirectBinding;
  readonly status: WireStatus;
  readonly awaitingKind?: 'approval' | 'question' | 'budget';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestSequence: number;
  readonly title?: string;
  readonly model?: WireModel;
  readonly pendingInteractionCount: number;
  readonly activeBackgroundTaskCount: number;
  readonly live: boolean;
};

export type SessionVisibility =
  | { readonly visible: true; readonly workspaceId: string; readonly workspaceRoot?: string }
  | { readonly visible: false };

export type SessionVisibilityResolver = (
  principal: Principal,
  record: SessionIndexRecord,
) => SessionVisibility | Promise<SessionVisibility>;

export type SessionListStreamEvent =
  | ({ readonly event: 'session.list.snapshot' } & SessionListSnapshotEvent)
  | ({ readonly event: 'session.list.upsert' } & SessionListUpsertEvent)
  | ({ readonly event: 'session.list.remove' } & SessionListRemoveEvent);

export type SessionIndexDeps = {
  /** Lists dormant session summaries from the store without calling host.connect(). */
  readonly listStored: () => ReturnType<DirectSessionStore['list']>;
  /** Optional binding/metadata lookup for newly created live sessions whose snapshot lacks binding. */
  readonly resolveBinding?: (sessionId: string) => {
    readonly binding?: DirectBinding;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  } | null;
  /** Principal-scoped visibility & opaque workspaceId projection (injected by app layer). */
  readonly resolveVisibility: SessionVisibilityResolver;
  /** Whether HTTP-safe minimal fields or full Client API fields are projected (default true). */
  readonly includeCounts?: boolean;
  /** Coalesce window for updatedAt/latestSequence-only ticks during turns (default 100ms). */
  readonly coalesceMs?: number;
};

export interface SessionIndex {
  seed(): Promise<void>;
  refresh(sessionId: string): Promise<void>;
  observeLifecycle(event: DirectHostLifecycleEvent): void;
  notifyWorkspaceRevoked(root: string): Promise<void>;
  notifyWorkspaceGranted(principal: Principal, root: string): Promise<void>;
  list(
    principal: Principal,
    options?: { readonly limit?: number; readonly cursor?: string; readonly workspaceId?: string },
  ): Promise<{ readonly sessions: ClientApiSessionListItem[]; readonly nextCursor: string | null }>;
  subscribe(
    principal: Principal,
    options: { readonly workspaceId?: string; readonly limit?: number },
    listener: (event: SessionListStreamEvent) => void,
  ): Promise<{ readonly unsubscribe: () => void }>;
  counts(): {
    readonly activeSessionCount: number;
    readonly activeTurnCount: number;
    readonly activeBackgroundTaskCount: number;
  };
  dispose(): void;
}

type Subscriber = {
  readonly principal: Principal;
  readonly workspaceId?: string;
  readonly visibleIds: Set<string>;
  readonly listener: (event: SessionListStreamEvent) => void;
};

type ListCursor = { readonly ownerUserId: string; readonly updatedAt: string; readonly id: string };

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/u;

function compareSessionListItems(a: ClientApiSessionListItem, b: ClientApiSessionListItem): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function normalizeDormantStatus(status: WireStatus | undefined): WireStatus {
  if (status === 'running' || status === 'awaiting_interaction') return 'interrupted';
  return status ?? 'idle';
}

function encodeListCursor(ownerUserId: string, item: ClientApiSessionListItem): string {
  return Buffer.from(JSON.stringify({ ownerUserId, updatedAt: item.updatedAt, id: item.id })).toString('base64url');
}

function decodeListCursor(cursor: string, ownerUserId: string): ListCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as ListCursor | null;
    if (
      !parsed ||
      parsed.ownerUserId !== ownerUserId ||
      typeof parsed.updatedAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !OPAQUE_ID.test(parsed.id)
    ) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new ServerHttpError(400, 'invalid_cursor', 'session cursor is invalid');
  }
}

function isImmediateChange(prev: SessionIndexRecord | undefined, next: SessionIndexRecord): boolean {
  if (!prev) return true;
  return (
    prev.status !== next.status ||
    prev.awaitingKind !== next.awaitingKind ||
    prev.title !== next.title ||
    prev.model?.provider !== next.model?.provider ||
    prev.model?.model !== next.model?.model ||
    prev.pendingInteractionCount !== next.pendingInteractionCount ||
    prev.activeBackgroundTaskCount !== next.activeBackgroundTaskCount ||
    prev.live !== next.live ||
    prev.workspaceRoot !== next.workspaceRoot
  );
}

function sameRecord(a: SessionIndexRecord | undefined, b: SessionIndexRecord): boolean {
  return (
    a !== undefined &&
    !isImmediateChange(a, b) &&
    a.updatedAt === b.updatedAt &&
    a.latestSequence === b.latestSequence &&
    a.createdAt === b.createdAt
  );
}

export function createSessionIndex(deps: SessionIndexDeps): SessionIndex {
  const records = new Map<string, SessionIndexRecord>();
  const subscribers = new Set<Subscriber>();
  const coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const coalesceMs = deps.coalesceMs ?? 100;
  const includeCounts = deps.includeCounts ?? true;
  let disposed = false;

  const projectItem = (
    record: SessionIndexRecord,
    visibility: Extract<SessionVisibility, { visible: true }>,
  ): ClientApiSessionListItem => ({
    id: record.id,
    workspaceId: visibility.workspaceId,
    ...(visibility.workspaceRoot ? { workspaceRoot: visibility.workspaceRoot } : {}),
    status: record.status,
    ...(record.awaitingKind ? { awaitingKind: record.awaitingKind } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    latestSequence: record.latestSequence,
    ...(record.title ? { title: record.title } : {}),
    ...(record.model ? { model: { provider: record.model.provider, model: record.model.model } } : {}),
    ...(includeCounts
      ? {
          pendingInteractionCount: record.pendingInteractionCount,
          activeBackgroundTaskCount: record.activeBackgroundTaskCount,
        }
      : {}),
  });

  const cancelPendingUpsert = (sessionId: string): void => {
    const timer = coalesceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      coalesceTimers.delete(sessionId);
    }
  };

  const fanoutUpsert = async (sessionId: string): Promise<void> => {
    if (disposed || subscribers.size === 0) return;
    const record = records.get(sessionId);
    if (!record) return;
    for (const sub of [...subscribers]) {
      try {
        const vis = await deps.resolveVisibility(sub.principal, record);
        if (vis.visible && (!sub.workspaceId || sub.workspaceId === vis.workspaceId)) {
          sub.visibleIds.add(sessionId);
          sub.listener({ event: 'session.list.upsert', session: projectItem(record, vis) });
        } else if (sub.visibleIds.delete(sessionId)) {
          sub.listener({ event: 'session.list.remove', sessionId, reason: 'workspace_revoked' });
        }
      } catch {
        // Visibility error on one subscriber must never disrupt other subscribers.
      }
    }
  };

  const scheduleUpsert = (record: SessionIndexRecord, immediate: boolean): void => {
    const previous = records.get(record.id);
    if (sameRecord(previous, record)) return;
    const urgent = immediate || isImmediateChange(previous, record);
    records.set(record.id, record);
    if (disposed || subscribers.size === 0) return;
    if (urgent || coalesceMs <= 0) {
      cancelPendingUpsert(record.id);
      void fanoutUpsert(record.id);
      return;
    }
    if (!coalesceTimers.has(record.id)) {
      const timer = setTimeout(() => {
        coalesceTimers.delete(record.id);
        void fanoutUpsert(record.id);
      }, coalesceMs);
      timer.unref?.();
      coalesceTimers.set(record.id, timer);
    }
  };

  const upsertFromStoredSummary = (
    summary: Awaited<ReturnType<DirectSessionStore['list']>>['sessions'][number],
    notify: boolean,
  ): void => {
    const existing = records.get(summary.id);
    // Live attachments remain authoritative while open; never clobber live status with dormant store scan.
    if (existing?.live) return;
    const now = new Date().toISOString();
    const updatedAt = summary.updatedAt ?? summary.createdAt ?? existing?.updatedAt ?? now;
    const createdAt = summary.createdAt ?? updatedAt;
    const title = summary.fullTitle ?? summary.title;
    const next: SessionIndexRecord = {
      id: summary.id,
      workspaceRoot: summary.workspace.root,
      ...(summary.binding ? { binding: summary.binding } : {}),
      status: normalizeDormantStatus(summary.status),
      createdAt,
      updatedAt,
      latestSequence: summary.latestSequence ?? 0,
      ...(title ? { title } : {}),
      model: summary.model,
      pendingInteractionCount: 0,
      activeBackgroundTaskCount: 0,
      live: false,
    };
    if (notify) scheduleUpsert(next, true);
    else records.set(next.id, next);
  };

  const collectVisible = async (principal: Principal, workspaceId?: string): Promise<ClientApiSessionListItem[]> => {
    const items: ClientApiSessionListItem[] = [];
    for (const record of records.values()) {
      try {
        const vis = await deps.resolveVisibility(principal, record);
        if (vis.visible && (!workspaceId || workspaceId === vis.workspaceId)) {
          items.push(projectItem(record, vis));
        }
      } catch {
        // Unauthorized/unresolvable sessions are omitted from lists.
      }
    }
    items.sort(compareSessionListItems);
    return items;
  };

  return {
    async seed() {
      const page = await deps.listStored();
      for (const summary of page.sessions) upsertFromStoredSummary(summary, false);
    },

    async refresh(sessionId) {
      const page = await deps.listStored();
      const match = page.sessions.find((entry) => entry.id === sessionId);
      if (match) upsertFromStoredSummary(match, true);
    },

    observeLifecycle(event) {
      if (disposed) return;
      const existing = records.get(event.sessionId);
      const bindingMeta = !existing?.binding || !existing?.createdAt ? deps.resolveBinding?.(event.sessionId) : null;
      const now = new Date().toISOString();
      if (event.kind === 'closed') {
        const summary = deriveSnapshotSummary(event.lastSnapshot);
        const closedRecord: SessionIndexRecord = {
          id: event.sessionId,
          workspaceRoot: event.workspace.root,
          ...(existing?.binding ?? bindingMeta?.binding ? { binding: existing?.binding ?? bindingMeta?.binding } : {}),
          status: normalizeDormantStatus(summary.status),
          createdAt: existing?.createdAt ?? bindingMeta?.createdAt ?? now,
          updatedAt: existing?.updatedAt ?? bindingMeta?.updatedAt ?? now,
          latestSequence: summary.latestSequence || existing?.latestSequence || 0,
          ...(summary.title ?? existing?.title ? { title: summary.title ?? existing?.title } : {}),
          ...(summary.model ?? existing?.model ? { model: summary.model ?? existing?.model } : {}),
          pendingInteractionCount: 0,
          activeBackgroundTaskCount: 0,
          live: false,
        };
        scheduleUpsert(closedRecord, true);
        return;
      }
      const summary = deriveSnapshotSummary(event.snapshot);
      const batchTime =
        event.batch && 'occurredAt' in event.batch && typeof event.batch.occurredAt === 'string'
          ? event.batch.occurredAt
          : undefined;
      const createdAt = existing?.createdAt ?? bindingMeta?.createdAt ?? batchTime ?? now;
      const updatedAt = batchTime ?? bindingMeta?.updatedAt ?? existing?.updatedAt ?? createdAt;
      const next: SessionIndexRecord = {
        id: event.sessionId,
        workspaceRoot: event.workspace.root,
        ...(existing?.binding ?? bindingMeta?.binding ? { binding: existing?.binding ?? bindingMeta?.binding } : {}),
        status: summary.status,
        ...(summary.awaitingKind ? { awaitingKind: summary.awaitingKind } : {}),
        createdAt,
        updatedAt,
        latestSequence: summary.latestSequence,
        ...(summary.title ? { title: summary.title } : {}),
        ...(summary.model ? { model: summary.model } : {}),
        pendingInteractionCount: summary.pendingInteractionCount,
        activeBackgroundTaskCount: summary.activeBackgroundTaskCount,
        live: true,
      };
      scheduleUpsert(next, event.batch === null);
    },

    async notifyWorkspaceRevoked(root) {
      if (disposed) return;
      const affected = [...records.values()].filter((record) => record.workspaceRoot === root);
      for (const record of affected) {
        // Causal coalescing invariant (client-api.md §5.3): cancel any pending upsert before emitting remove.
        cancelPendingUpsert(record.id);
      }
      for (const sub of [...subscribers]) {
        for (const record of affected) {
          if (!sub.visibleIds.has(record.id)) continue;
          let stillVisible = false;
          try {
            const vis = await deps.resolveVisibility(sub.principal, record);
            stillVisible = vis.visible && (!sub.workspaceId || sub.workspaceId === vis.workspaceId);
          } catch {
            stillVisible = false;
          }
          if (!stillVisible) {
            sub.visibleIds.delete(record.id);
            sub.listener({ event: 'session.list.remove', sessionId: record.id, reason: 'workspace_revoked' });
          }
        }
      }
    },

    async notifyWorkspaceGranted(principal, root) {
      if (disposed) return;
      const affected = [...records.values()].filter((record) => record.workspaceRoot === root);
      for (const sub of [...subscribers]) {
        if (sub.principal.userId !== principal.userId) continue;
        for (const record of affected) {
          try {
            const vis = await deps.resolveVisibility(sub.principal, record);
            if (vis.visible && (!sub.workspaceId || sub.workspaceId === vis.workspaceId)) {
              sub.visibleIds.add(record.id);
              sub.listener({ event: 'session.list.upsert', session: projectItem(record, vis) });
            }
          } catch {
            // Skip unresolvable record.
          }
        }
      }
    },

    async list(principal, options) {
      const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
      const after = options?.cursor ? decodeListCursor(options.cursor, principal.userId) : undefined;
      const all = await collectVisible(principal, options?.workspaceId);
      const remaining = after
        ? all.filter(
            (item) => item.updatedAt < after.updatedAt || (item.updatedAt === after.updatedAt && item.id > after.id),
          )
        : all;
      const sessions = remaining.slice(0, limit);
      const last = sessions[sessions.length - 1];
      const nextCursor = remaining.length > limit && last ? encodeListCursor(principal.userId, last) : null;
      return { sessions, nextCursor };
    },

    async subscribe(principal, options, listener) {
      const limit = Math.max(1, Math.min(500, options.limit ?? 200));
      // Capture snapshot and register subscriber without dropping updates arriving during visibility resolution.
      const queued: SessionListStreamEvent[] = [];
      let ready = false;
      const subscriber: Subscriber = {
        principal: { ...principal },
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        visibleIds: new Set<string>(),
        listener: (event) => {
          if (ready) listener(event);
          else queued.push(event);
        },
      };
      subscribers.add(subscriber);
      try {
        const all = await collectVisible(principal, options.workspaceId);
        const sessions = all.slice(0, limit);
        const truncated = all.length > limit;
        const last = sessions[sessions.length - 1];
        const nextCursor = truncated && last ? encodeListCursor(principal.userId, last) : null;
        for (const item of all) subscriber.visibleIds.add(item.id);
        const streamEpoch = `ep_${randomUUID().replaceAll('-', '')}`;
        listener({
          event: 'session.list.snapshot',
          streamEpoch,
          sessions,
          truncated,
          nextCursor,
        });
        ready = true;
        for (const buffered of queued) listener(buffered);
        queued.length = 0;
      } catch (error) {
        subscribers.delete(subscriber);
        throw error;
      }
      return {
        unsubscribe: () => {
          subscribers.delete(subscriber);
        },
      };
    },

    counts() {
      let activeSessionCount = 0;
      let activeTurnCount = 0;
      let activeBackgroundTaskCount = 0;
      for (const record of records.values()) {
        if (!record.live) continue;
        activeSessionCount += 1;
        if (record.status === 'running' || record.status === 'awaiting_interaction') activeTurnCount += 1;
        activeBackgroundTaskCount += record.activeBackgroundTaskCount;
      }
      return { activeSessionCount, activeTurnCount, activeBackgroundTaskCount };
    },

    dispose() {
      disposed = true;
      for (const timer of coalesceTimers.values()) clearTimeout(timer);
      coalesceTimers.clear();
      subscribers.clear();
    },
  };
}
