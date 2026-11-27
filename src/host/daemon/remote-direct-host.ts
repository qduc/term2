/**
 * Remote `DirectHost` and `DirectConnection` over `UnixRpcClient` (Step 14b).
 *
 * Implements the exact `DirectHost` / `DirectConnection` / `DirectReplayConnection`
 * contract over the frozen Client API v1.0 Unix NDJSON transport, plus typed helpers
 * for daemon-level control, session-list streaming, and global settings/catalog RPCs.
 */
import path from 'node:path';
import type {
  WireCommand,
  WireCommandErrorCode,
  WireCommandResult,
  WireEvent,
  WireSnapshot,
} from '../../protocol/wire.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import type {
  ClientApiErrorCode,
  ClientApiSessionListItem,
  DaemonShutdownParams,
  DaemonStatusResult,
  SessionApprovalPolicy,
  UnixEventFrame,
} from '../../protocol/client-api/client-api-schema.js';
import type { DirectSessionStore } from '../../session/facade-types.js';
import type {
  DirectConnection,
  DirectHost,
  DirectReplayConnection,
  Principal,
  WorkspaceGrant,
} from '../in-process-direct-types.js';
import { DirectEventQueue } from '../in-process-direct-queue.js';
import { ClientApiRpcError } from './daemon-errors.js';
import type { UnixRpcClient } from './unix-rpc-client.js';

type ProtocolFailureCode = Exclude<WireCommandErrorCode, 'command_rejected' | 'command_interrupted'>;

export type RemoteDirectHostOptions = {
  /** Optional default approval policy applied to `createSession()` calls (e.g., headless mode). */
  readonly defaultApprovalPolicy?: SessionApprovalPolicy;
  /** Timeout for initial `session.snapshot` event after `session.attach` succeeds. */
  readonly attachSnapshotTimeoutMs?: number;
};

export interface RemoteDirectHost extends DirectHost {
  readonly rpc: UnixRpcClient;
  status(): Promise<DaemonStatusResult>;
  shutdown(params?: Partial<DaemonShutdownParams>): Promise<void>;
  forkSession(sourceSessionId: string): Promise<ClientApiSessionListItem>;
  handoffSession(
    sourceSessionId: string,
    input?: { readonly name?: string; readonly text?: string },
  ): Promise<ClientApiSessionListItem>;
  subscribeSessionList(
    onEvent: (frame: UnixEventFrame) => void,
    options?: { readonly workspaceId?: string; readonly onClose?: (error?: Error) => void },
  ): Promise<{ readonly streamId: string; unsubscribe: () => Promise<void> }>;
  subscribeSettings(
    onEvent: (frame: UnixEventFrame) => void,
    options?: { readonly onClose?: (error?: Error) => void },
  ): Promise<{ readonly streamId: string; unsubscribe: () => Promise<void> }>;
  readSettings(): Promise<Record<string, unknown>>;
  updateSettings(
    expectedRevision: string,
    changes: readonly { readonly key: string; readonly value: unknown }[],
  ): Promise<Record<string, unknown>>;
  listModels(): Promise<readonly Record<string, unknown>[]>;
  listSkills(workspaceId?: string): Promise<readonly Record<string, unknown>[]>;
  getQuota(sessionId?: string): Promise<Record<string, unknown>>;
  getMcpStatus(input?: {
    readonly workspaceId?: string;
    readonly sessionId?: string;
  }): Promise<Record<string, unknown>>;
  loginMcp(serverId: string, workspaceId?: string): Promise<Record<string, unknown>>;
  listSessionFiles(sessionId: string): Promise<Record<string, unknown>>;
}

function toDirectProtocolCode(code: ClientApiErrorCode): ProtocolFailureCode {
  switch (code) {
    case 'unauthorized':
    case 'forbidden':
      return 'forbidden';
    case 'not_found':
      return 'not_found';
    case 'stale_interaction':
      return 'stale_interaction';
    case 'stale_revision':
      return 'request_conflict';
    case 'busy':
      return 'rejected';
    case 'cursor_out_of_range':
      return 'replay_unavailable';
    case 'closed':
      return 'closed';
    case 'invalid_request':
      return 'invalid_command';
    default:
      return 'unavailable';
  }
}

function rethrowAsProtocolError(error: unknown): never {
  if (error instanceof DirectProtocolError) throw error;
  if (error instanceof ClientApiRpcError) {
    throw new DirectProtocolError(toDirectProtocolCode(error.code), error.message);
  }
  throw error;
}

function toStoreSessionSummary(
  item: ClientApiSessionListItem,
): Awaited<ReturnType<DirectSessionStore['list']>>['sessions'][number] {
  const shortTitle = item.title ? (item.title.length > 60 ? item.title.slice(0, 60) : item.title) : undefined;
  return {
    id: item.id,
    workspace: {
      root: item.workspaceRoot ?? item.workspaceId,
      access: 'read_write',
      target: 'local',
    },
    model: {
      provider: item.model?.provider ?? '',
      model: item.model?.model ?? '',
    },
    ...(shortTitle ? { title: shortTitle } : {}),
    ...(item.title ? { fullTitle: item.title } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    latestSequence: item.latestSequence,
    status: item.status,
  };
}

export function createRemoteDirectHost(rpc: UnixRpcClient, options: RemoteDirectHostOptions = {}): RemoteDirectHost {
  const snapshotTimeoutMs = options.attachSnapshotTimeoutMs ?? 15_000;
  let disposed = false;

  const ensureOpen = (): void => {
    if (disposed || rpc.closed) {
      throw new DirectProtocolError('closed', 'Remote daemon host is closed.');
    }
  };

  async function dispatchCommand(sessionId: string, command: WireCommand): Promise<WireCommandResult> {
    ensureOpen();
    try {
      const response = await rpc.request<{ readonly result: WireCommandResult }>('session.command', {
        sessionId,
        command: command as unknown as Record<string, unknown>,
      });
      return response.result;
    } catch (error) {
      if (error instanceof ClientApiRpcError) {
        if (error.code === 'closed' || error.code === 'forbidden' || error.code === 'unauthorized') {
          throw new DirectProtocolError(toDirectProtocolCode(error.code), error.message);
        }
        const commandId =
          'commandId' in command && typeof command.commandId === 'string' ? command.commandId : undefined;
        return {
          ok: false,
          code: toDirectProtocolCode(error.code),
          message: error.message,
          ...(commandId ? { commandId } : {}),
        };
      }
      throw error;
    }
  }

  async function attachSession(sessionId: string): Promise<DirectConnection>;
  async function attachSession(sessionId: string, fromSeq: number): Promise<DirectReplayConnection>;
  async function attachSession(
    sessionId: string,
    fromSeq?: number,
  ): Promise<DirectConnection | DirectReplayConnection> {
    ensureOpen();
    let streamId = '';
    let retired = false;
    let ordinal = 0;
    let currentSnapshot: WireSnapshot | null = null;
    let snapshotSettled = fromSeq !== undefined;
    let resolveInitialSnapshot: ((snapshot: WireSnapshot) => void) | null = null;
    let rejectInitialSnapshot: ((error: Error) => void) | null = null;

    const initialSnapshotPromise =
      fromSeq === undefined
        ? new Promise<WireSnapshot>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (snapshotSettled) return;
              snapshotSettled = true;
              reject(new DirectProtocolError('unavailable', `Timed out waiting for initial snapshot of ${sessionId}.`));
            }, snapshotTimeoutMs);
            timer.unref?.();
            resolveInitialSnapshot = (snap) => {
              if (snapshotSettled) return;
              snapshotSettled = true;
              clearTimeout(timer);
              resolve(snap);
            };
            rejectInitialSnapshot = (err) => {
              if (snapshotSettled) return;
              snapshotSettled = true;
              clearTimeout(timer);
              reject(err);
            };
          })
        : null;

    const detachFromDaemon = () => {
      if (retired) return;
      retired = true;
      if (streamId && !rpc.closed) {
        void rpc.request('session.detach', { streamId }).catch(() => undefined);
      }
    };

    const queue = new DirectEventQueue(detachFromDaemon);

    const handleEvent = (frame: UnixEventFrame) => {
      if (frame.event === 'session.snapshot') {
        const snapshot = frame.payload['snapshot'] as WireSnapshot | undefined;
        if (!snapshot) return;
        currentSnapshot = snapshot;
        if (!snapshotSettled && resolveInitialSnapshot) {
          resolveInitialSnapshot(snapshot);
          return;
        }
        queue.push({
          kind: 'snapshot',
          seq: snapshot.seq,
          occurredAt: null,
          events: [
            {
              sessionId,
              turnId: null,
              type: 'snapshot',
              seq: snapshot.seq,
              occurredAt: new Date().toISOString(),
              payload: { snapshot },
            },
          ],
          ordinal: ++ordinal,
        });
        return;
      }
      if (frame.event === 'session.accepted') {
        const events = (frame.payload['events'] as WireEvent[] | undefined) ?? [];
        const seq = typeof frame.payload['seq'] === 'number' ? frame.payload['seq'] : null;
        const occurredAt = typeof frame.payload['occurredAt'] === 'string' ? frame.payload['occurredAt'] : null;
        if (events.length > 0) {
          queue.push({ kind: 'accepted', seq, occurredAt, events, ordinal: ++ordinal });
        }
        return;
      }
      if (frame.event === 'session.live') {
        const events = (frame.payload['events'] as WireEvent[] | undefined) ?? [];
        if (events.length > 0) {
          queue.push({ kind: 'live', seq: null, occurredAt: null, events, ordinal: ++ordinal });
        }
        return;
      }
      if (frame.event === 'session.resync_required') {
        retired = true;
        const err = new DirectProtocolError('replay_unavailable', 'Daemon stream requires resync.');
        rejectInitialSnapshot?.(err);
        queue.fail(err);
        return;
      }
      if (frame.event === 'session.closed') {
        retired = true;
        rejectInitialSnapshot?.(new DirectProtocolError('closed', `Session ${sessionId} closed before snapshot.`));
        queue.close();
      }
    };

    const handleSocketClose = (error?: Error) => {
      retired = true;
      const err = new DirectProtocolError('closed', error?.message ?? 'Daemon connection closed.');
      rejectInitialSnapshot?.(err);
      if (error) queue.fail(err);
      else queue.close();
    };

    let handle: Awaited<ReturnType<UnixRpcClient['subscribe']>>;
    try {
      handle = await rpc.subscribe(
        'session.attach',
        fromSeq !== undefined ? { sessionId, fromSeq, sessionEpoch: sessionId } : { sessionId },
        { onEvent: handleEvent, onClose: handleSocketClose },
      );
    } catch (error) {
      const rejectSnap = rejectInitialSnapshot as ((err: Error) => void) | null;
      rejectSnap?.(error instanceof Error ? error : new Error(String(error)));
      initialSnapshotPromise?.catch(() => undefined);
      rethrowAsProtocolError(error);
    }
    streamId = handle.streamId;

    const closeConnection = () => {
      handle.retireLocal();
      queue.close();
    };

    if (fromSeq !== undefined) {
      const replayConnection: DirectReplayConnection = {
        sessionId,
        snapshot: null,
        replay: { fromSeq, toSeq: fromSeq },
        events: queue,
        batches: () => queue.batches(),
        send: (command) => dispatchCommand(sessionId, command),
        close: closeConnection,
      };
      return replayConnection;
    }

    let snapshot: WireSnapshot;
    try {
      snapshot = await initialSnapshotPromise!;
    } catch (error) {
      closeConnection();
      rethrowAsProtocolError(error);
    }

    const connection: DirectConnection = {
      sessionId,
      snapshot,
      events: queue,
      batches: () => queue.batches(),
      cut: () => ({ snapshot: currentSnapshot ?? snapshot, ordinal }),
      send: (command) => dispatchCommand(sessionId, command),
      close: closeConnection,
    };
    return connection;
  }

  async function listSessions(_principal: Principal, cursor?: string): ReturnType<DirectSessionStore['list']> {
    ensureOpen();
    try {
      const result = await rpc.request<{
        readonly sessions: readonly ClientApiSessionListItem[];
        readonly nextCursor?: string;
      }>('session.list', cursor ? { cursor } : {});
      return {
        sessions: result.sessions.map(toStoreSessionSummary),
        ...(result.nextCursor ? { cursor: result.nextCursor } : {}),
      };
    } catch (error) {
      rethrowAsProtocolError(error);
    }
  }

  async function createSession(_principal: Principal, grant: WorkspaceGrant): Promise<DirectConnection> {
    ensureOpen();
    try {
      const params: Record<string, unknown> = {
        ...(path.isAbsolute(grant.workspaceId) ? { cwd: grant.workspaceId } : { workspaceId: grant.workspaceId }),
        ...(options.defaultApprovalPolicy ? { approvalPolicy: options.defaultApprovalPolicy } : {}),
      };
      const created = await rpc.request<{ readonly session: ClientApiSessionListItem }>('session.create', params);
      return await attachSession(created.session.id);
    } catch (error) {
      rethrowAsProtocolError(error);
    }
  }

  function connect(_principal: Principal, sessionId: string): Promise<DirectConnection>;
  function connect(_principal: Principal, sessionId: string, fromSeq: number): Promise<DirectReplayConnection>;
  function connect(
    _principal: Principal,
    sessionId: string,
    fromSeq?: number,
  ): Promise<DirectConnection | DirectReplayConnection> {
    return fromSeq !== undefined ? attachSession(sessionId, fromSeq) : attachSession(sessionId);
  }

  return {
    rpc,
    listSessions,
    createSession,
    connect,
    sendCommand: (_principal, sessionId, command) => dispatchCommand(sessionId, command),
    async dispose() {
      disposed = true;
      rpc.close();
    },
    async status() {
      ensureOpen();
      return (await rpc.request<DaemonStatusResult>('daemon.status')) as DaemonStatusResult;
    },
    async shutdown(params) {
      ensureOpen();
      await rpc.request('daemon.shutdown', params ? { ...params } : { mode: 'graceful' });
    },
    async forkSession(sourceSessionId) {
      ensureOpen();
      const res = await rpc.request<{ readonly session: ClientApiSessionListItem }>('session.fork', {
        sourceSessionId,
      });
      return res.session;
    },
    async handoffSession(sourceSessionId, input) {
      ensureOpen();
      const res = await rpc.request<{ readonly session: ClientApiSessionListItem }>('session.handoff', {
        sourceSessionId,
        ...(input?.name ? { name: input.name } : {}),
        ...(input?.text ? { text: input.text } : {}),
      });
      return res.session;
    },
    async subscribeSessionList(onEvent, subOptions) {
      ensureOpen();
      const handle = await rpc.subscribe(
        'session.list.subscribe',
        subOptions?.workspaceId ? { workspaceId: subOptions.workspaceId } : {},
        { onEvent, onClose: subOptions?.onClose },
      );
      return {
        streamId: handle.streamId,
        async unsubscribe() {
          handle.retireLocal();
          if (!rpc.closed) {
            await rpc.request('session.list.unsubscribe', { streamId: handle.streamId }).catch(() => undefined);
          }
        },
      };
    },
    async subscribeSettings(onEvent, subOptions) {
      ensureOpen();
      const handle = await rpc.subscribe('settings.subscribe', {}, { onEvent, onClose: subOptions?.onClose });
      return {
        streamId: handle.streamId,
        async unsubscribe() {
          handle.retireLocal();
          if (!rpc.closed) {
            await rpc.request('settings.unsubscribe', { streamId: handle.streamId }).catch(() => undefined);
          }
        },
      };
    },
    async readSettings() {
      ensureOpen();
      return await rpc.request('settings.get');
    },
    async updateSettings(expectedRevision, changes) {
      ensureOpen();
      return await rpc.request('settings.update', { expectedRevision, changes });
    },
    async listModels() {
      ensureOpen();
      const res = await rpc.request<{ readonly models: readonly Record<string, unknown>[] }>('models.list');
      return res.models;
    },
    async listSkills(workspaceId) {
      ensureOpen();
      const res = await rpc.request<{ readonly skills: readonly Record<string, unknown>[] }>(
        'skills.list',
        workspaceId ? { workspaceId } : {},
      );
      return res.skills;
    },
    async getQuota(sessionId) {
      ensureOpen();
      return await rpc.request('quota.get', sessionId ? { sessionId } : {});
    },
    async getMcpStatus(input) {
      ensureOpen();
      return await rpc.request('mcp.status', input ? { ...input } : {});
    },
    async loginMcp(serverId, workspaceId) {
      ensureOpen();
      return await rpc.request('mcp.login', { serverId, ...(workspaceId ? { workspaceId } : {}) });
    },
    async listSessionFiles(sessionId) {
      ensureOpen();
      return await rpc.request('session.files', { sessionId });
    },
  };
}
