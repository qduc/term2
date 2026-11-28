/**
 * ACP sessions inside the daemon (`session.acp.set_mcp`, `client-api.md` §9; decisions in
 * `.handoff/step14e-part2b-acp.md` until the plan records them).
 *
 * An ACP session gets only the MCP servers its ACP client supplies, never the daemon's
 * per-workspace pool (`daemon-mcp.ts`), exactly as in-process `term2 acp` never loads
 * user or project MCP configuration. The servers run inside the daemon through the
 * same `createAcpSessions` that in-process ACP uses, so validation, atomic replacement,
 * stdio environment and tool generations do not fork.
 *
 * An installation lives no longer than the session or the Unix connection that made it
 * (`local_leases`): connection EOF closes its MCP processes and rebuilds the session's
 * tools without them, as the end of an in-process ACP process would have.
 */
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { DirectConnection, DirectHostLifecycleEvent, Principal } from '../../host/in-process-direct-types.js';
import { ClientApiRpcError } from '../../host/daemon/daemon-errors.js';
import type { DaemonRpcConnectionContext as DaemonConnection } from '../../host/daemon/daemon-rpc-v11.js';
import type { SessionIndex } from '../../host/daemon/session-index.js';
import type { ModelRef } from '../../model/index.js';
import { createDirectMcpRefresh } from '../application-mcp.js';
import type { DirectApplication } from '../application.js';
import { LOCAL_PRINCIPAL, requireLocalCaller } from '../application-workspaces.js';
import { authorizeAcpModel, type AcpRequest } from './acp-common.js';
import { createAcpSessions } from './acp-sessions.js';

const meta = z.record(z.string(), z.unknown()).nullish();
const pair = z.strictObject({ name: z.string(), value: z.string(), _meta: meta });
/** The ACP v1 `McpServer` union, as `session/new` and `session/load` carry it. */
const AcpMcpServerSchema = z.union([
  z.strictObject({ name: z.string(), command: z.string(), args: z.array(z.string()), env: z.array(pair), _meta: meta }),
  z.strictObject({
    type: z.enum(['http', 'sse']),
    name: z.string(),
    url: z.string(),
    headers: z.array(pair),
    _meta: meta,
  }),
]);

function parseServers(servers: readonly Record<string, unknown>[]): acp.McpServer[] {
  const parsed = z.array(AcpMcpServerSchema).safeParse(servers);
  if (!parsed.success) throw new ClientApiRpcError('invalid_request', 'Invalid ACP MCP server list.');
  return parsed.data as acp.McpServer[];
}

/** ACP request errors become Client API errors; the ACP client maps them back. */
function rpcError(error: unknown): unknown {
  if (error instanceof ClientApiRpcError || !(error instanceof acp.RequestError)) return error;
  return new ClientApiRpcError(error.code === -32602 ? 'invalid_request' : 'unavailable', error.message);
}

export type DaemonAcpDeps = {
  readonly app: DirectApplication;
  /** The daemon's own settings: they decide which models an ACP session may move to. */
  readonly selection: AcpRequest['selection'];
  /** True only for a live session whose runtime was built with the ACP surface. */
  readonly isAcpSession: (sessionId: string) => boolean;
  readonly sessionIndex: SessionIndex;
};

export function createDaemonAcp(deps: DaemonAcpDeps) {
  const warn = (message: string) => deps.selection.logger.warn(message);
  const sessionRoot = async (sessionId: string): Promise<string> => {
    const root = (await deps.sessionIndex.get(LOCAL_PRINCIPAL, sessionId))?.workspaceRoot;
    if (!root) throw new ClientApiRpcError('not_found', 'Unknown local session workspace.');
    return root;
  };
  const sessions = createAcpSessions();
  const owners = new Map<string, string>();
  const watched = new Set<string>();
  const chains = new Map<string, Promise<unknown>>();
  const catalogListeners = new Set<() => void>();
  const refresh = createDirectMcpRefresh(
    {
      onCatalogChanged(listener) {
        const stop = sessions.onCatalogChanged(listener);
        catalogListeners.add(listener);
        return () => {
          stop();
          catalogListeners.delete(listener);
        };
      },
    },
    warn,
  );

  const serialize = <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(operation, operation);
    const settled = next.catch(() => undefined);
    chains.set(sessionId, settled);
    void settled.finally(() => {
      if (chains.get(sessionId) === settled) chains.delete(sessionId);
    });
    return next;
  };

  const connect = (sessionId: string) => async (): Promise<DirectConnection> => {
    const connection = await deps.app.host.connect(LOCAL_PRINCIPAL, sessionId);
    // A session closed meanwhile reopens without the ACP surface; never install into it.
    if (!deps.isAcpSession(sessionId)) {
      connection.close();
      throw new ClientApiRpcError('not_found', 'Session is not open as an ACP session.');
    }
    return connection;
  };

  /** Close one session's MCP processes; a session that stays open rebuilds its tools without them when idle. */
  const release = async (sessionId: string, open: boolean): Promise<void> => {
    owners.delete(sessionId);
    await sessions.close(sessionId);
    if (open) for (const listener of catalogListeners) listener();
  };

  const watch = (connection: DaemonConnection): void => {
    if (watched.has(connection.connectionId)) return;
    watched.add(connection.connectionId);
    connection.onDisconnect(() => {
      watched.delete(connection.connectionId);
      for (const [sessionId, owner] of owners) {
        if (owner !== connection.connectionId) continue;
        void serialize(sessionId, async () => {
          if (owners.get(sessionId) === connection.connectionId) await release(sessionId, true);
        }).catch((error: unknown) => warn(`ACP MCP cleanup for ${sessionId} failed: ${String(error)}`));
      }
    });
  };

  return {
    /** The session's tool surface reads only its ACP-supplied servers. */
    surface: (sessionId: string) => sessions.surface(sessionId),
    /** `prepareSurface` for an ACP session: follow its servers' catalog changes. */
    prepare(sessionId: string) {
      const epoch = refresh.epoch;
      return {
        trackMcpCatalog: (session: Parameters<typeof refresh.track>[0]) => refresh.track(session, epoch),
        dispose: async () => refresh.untrack(sessionId),
      };
    },
    authorizeModel: (next: ModelRef, previous: ModelRef) => authorizeAcpModel(deps.selection.settings, next, previous),
    /**
     * Runs after a launch opened or found its session, before any configuration applies.
     * A live session keeps the surface it opened with, so ACP never drives another
     * client's (in-process: the writer lock). Assisted and Unattended rely on ACP v1's
     * sandboxed-shell review, which a launch cannot ask for (`clientMode` has no ACP
     * version); without it they would run mutating sandboxed commands unreviewed.
     */
    admitLaunch(sessionId: string, params: { readonly clientMode?: string; readonly approvalMode?: string }): void {
      if (params.clientMode !== 'acp') return;
      if (!deps.isAcpSession(sessionId))
        throw new ClientApiRpcError(
          'busy',
          'Session is open for another client; close it before resuming it over ACP.',
        );
      if (params.approvalMode === 'auto' || params.approvalMode === 'unattended')
        throw new ClientApiRpcError(
          'unavailable',
          'Assisted and Unattended approval are not available over the term2 daemon yet; run term2 acp with TERM2_IN_PROCESS=1 to use them.',
        );
    },
    async setMcp(
      principal: Principal,
      params: { readonly sessionId: string; readonly servers: readonly Record<string, unknown>[] },
      connection: DaemonConnection,
    ): Promise<void> {
      requireLocalCaller(principal);
      const mcpServers = parseServers(params.servers);
      const { sessionId } = params;
      await serialize(sessionId, async () => {
        if (!deps.isAcpSession(sessionId)) {
          throw new ClientApiRpcError('not_found', 'Session is not open as an ACP session.');
        }
        if (mcpServers.length === 0 && !owners.has(sessionId)) return;
        try {
          const opened = await sessions.open(
            { cwd: await sessionRoot(sessionId), sessionId, mcpServers },
            connect(sessionId),
          );
          opened.close();
        } catch (error) {
          throw rpcError(error);
        }
        if (mcpServers.length === 0) {
          owners.delete(sessionId);
          return;
        }
        owners.set(sessionId, connection.connectionId);
        watch(connection);
      });
    },
    observeLifecycle(event: DirectHostLifecycleEvent): void {
      if (event.kind !== 'closed') return;
      void serialize(event.sessionId, () => release(event.sessionId, false)).catch((error: unknown) =>
        warn(`ACP MCP close for ${event.sessionId} failed: ${String(error)}`),
      );
    },
    async close(): Promise<void> {
      refresh.close();
      await sessions.shutdown();
      owners.clear();
    },
  };
}
