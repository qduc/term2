/**
 * Remote `DirectHost` and `DirectConnection` over `UnixRpcClient` (Step 14b).
 *
 * Implements the exact `DirectHost` / `DirectConnection` / `DirectReplayConnection`
 * contract over the frozen Client API v1.0 Unix NDJSON transport, plus typed helpers
 * for daemon-level control, session-list streaming, and global settings/catalog RPCs.
 */
import path from 'node:path';
import type { WireCommand, WireCommandErrorCode, WireCommandResult } from '../../protocol/wire.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import type {
  ClientApiErrorCode,
  ClientApiSessionListItem,
  DaemonShutdownParams,
  DaemonStatusResult,
  ModelsListParamsV11,
  SessionApprovalPolicy,
  SessionLaunchParams,
  SessionLaunchResult,
  SettingsUpdateParamsV11,
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
import { ClientApiRpcError } from './daemon-errors.js';
import { attachRemoteDirectSession } from './remote-direct-attachment.js';
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
  launchSession(params: SessionLaunchParams): Promise<SessionLaunchResult>;
  listSessionsByCwd(
    cwd: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<{ readonly sessions: readonly ClientApiSessionListItem[]; readonly nextCursor: string | null }>;
  forkSession(sourceSessionId: string): Promise<ClientApiSessionListItem>;
  handoffSession(
    sourceSessionId: string,
    input?: {
      readonly name?: string;
      readonly text?: string;
      readonly model?: { readonly provider: string; readonly model: string };
    },
  ): Promise<ClientApiSessionListItem>;
  subscribeSessionList(
    onEvent: (frame: UnixEventFrame) => void,
    options?: { readonly workspaceId?: string; readonly onClose?: (error?: Error) => void },
  ): Promise<{ readonly streamId: string; unsubscribe: () => Promise<void> }>;
  subscribeSettings(
    onEvent: (frame: UnixEventFrame) => void,
    options?: {
      readonly sessionId?: string;
      readonly view?: 'web' | 'tui';
      readonly onClose?: (error?: Error) => void;
    },
  ): Promise<{ readonly streamId: string; unsubscribe: () => Promise<void> }>;
  readSettings(options?: {
    readonly sessionId?: string;
    readonly view?: 'web' | 'tui';
  }): Promise<Record<string, unknown>>;
  updateSettings(
    expectedRevision: string,
    changes: readonly { readonly key: string; readonly value: unknown }[],
  ): Promise<Record<string, unknown>>;
  updateScopedSettings(params: SettingsUpdateParamsV11): Promise<Record<string, unknown>>;
  listModels(options?: ModelsListParamsV11): Promise<readonly Record<string, unknown>[]>;
  listProviderModels(options: ModelsListParamsV11): Promise<Record<string, unknown>>;
  listProviderPresets(): Promise<Record<string, unknown>>;
  upsertProvider(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteProvider(providerId: string): Promise<Record<string, unknown>>;
  setCredential(provider: string, value: string): Promise<Record<string, unknown>>;
  deleteCredential(provider: string): Promise<Record<string, unknown>>;
  oauthLogin(provider: 'codex' | 'grok'): Promise<Record<string, unknown>>;
  oauthSelect(provider: 'codex' | 'grok', accountId: string): Promise<Record<string, unknown>>;
  oauthDelete(provider: 'codex' | 'grok', accountId?: string): Promise<Record<string, unknown>>;
  listSkills(scope?: {
    readonly workspaceId?: string;
    readonly sessionId?: string;
  }): Promise<readonly Record<string, unknown>[]>;
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
    try {
      return await attachRemoteDirectSession(rpc, sessionId, fromSeq, snapshotTimeoutMs, (command) =>
        dispatchCommand(sessionId, command),
      );
    } catch (error) {
      rethrowAsProtocolError(error);
    }
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
    async closeSession(_principal, sessionId) {
      ensureOpen();
      try {
        await rpc.request('session.close', { sessionId });
      } catch (error) {
        rethrowAsProtocolError(error);
      }
    },
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
    async launchSession(params) {
      ensureOpen();
      return (await rpc.request<SessionLaunchResult>(
        'session.launch',
        params as unknown as Record<string, unknown>,
      )) as SessionLaunchResult;
    },
    async listSessionsByCwd(cwd, listOptions) {
      ensureOpen();
      return (await rpc.request('session.list', {
        cwd,
        ...(listOptions?.limit !== undefined ? { limit: listOptions.limit } : {}),
        ...(listOptions?.cursor !== undefined ? { cursor: listOptions.cursor } : {}),
      })) as { readonly sessions: readonly ClientApiSessionListItem[]; readonly nextCursor: string | null };
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
        ...(input?.model ? { model: input.model } : {}),
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
      const params: Record<string, unknown> = {
        ...(subOptions?.sessionId ? { sessionId: subOptions.sessionId } : {}),
        ...(subOptions?.view ? { view: subOptions.view } : {}),
      };
      const handle = await rpc.subscribe('settings.subscribe', params, { onEvent, onClose: subOptions?.onClose });
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
    async readSettings(readOptions) {
      ensureOpen();
      const params: Record<string, unknown> = {
        ...(readOptions?.sessionId ? { sessionId: readOptions.sessionId } : {}),
        ...(readOptions?.view ? { view: readOptions.view } : {}),
      };
      return await rpc.request('settings.get', Object.keys(params).length ? params : undefined);
    },
    async updateSettings(expectedRevision, changes) {
      ensureOpen();
      return await rpc.request('settings.update', { expectedRevision, changes });
    },
    async updateScopedSettings(params) {
      ensureOpen();
      return await rpc.request('settings.update', params as unknown as Record<string, unknown>);
    },
    async listModels(modelOptions) {
      ensureOpen();
      const res = await rpc.request<{ readonly models: readonly Record<string, unknown>[] }>(
        'models.list',
        modelOptions ? (modelOptions as unknown as Record<string, unknown>) : undefined,
      );
      return res.models;
    },
    async listProviderModels(modelOptions) {
      ensureOpen();
      return await rpc.request('models.list', modelOptions as unknown as Record<string, unknown>);
    },
    async listProviderPresets() {
      ensureOpen();
      return await rpc.request('providers.presets');
    },
    async upsertProvider(params) {
      ensureOpen();
      return await rpc.request('providers.upsert', params);
    },
    async deleteProvider(providerId) {
      ensureOpen();
      return await rpc.request('providers.delete', { providerId });
    },
    async setCredential(provider, value) {
      ensureOpen();
      return await rpc.request('credentials.set', { provider, value });
    },
    async deleteCredential(provider) {
      ensureOpen();
      return await rpc.request('credentials.delete', { provider });
    },
    async oauthLogin(provider) {
      ensureOpen();
      return await rpc.request('oauth.login', { provider });
    },
    async oauthSelect(provider, accountId) {
      ensureOpen();
      return await rpc.request('oauth.select', { provider, accountId });
    },
    async oauthDelete(provider, accountId) {
      ensureOpen();
      return await rpc.request('oauth.delete', accountId ? { provider, accountId } : { provider });
    },
    async listSkills(scope) {
      ensureOpen();
      const res = await rpc.request<{ readonly skills: readonly Record<string, unknown>[] }>('skills.list', scope);
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
      return await rpc.request('workspaces.files', { sessionId });
    },
  };
}
