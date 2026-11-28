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
 * One Unix connection holds an ACP session from its ACP admission (`session.launch` with
 * `clientMode: 'acp'`) until that connection ends, as one in-process ACP process holds
 * the session's writer lock. Only the holder may admit it again or change its MCP
 * servers (`local_leases`). The holder's EOF closes every MCP process the session ever
 * had and rebuilds its tools without them; session close does the same. While a holder
 * lives, the session reopens only with the ACP surface, whoever reopens it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { DirectConnection, DirectHostLifecycleEvent, Principal } from '../../host/in-process-direct-types.js';
import { ClientApiRpcError } from '../../host/daemon/daemon-errors.js';
import type {
  DaemonRpcConnectionContext as DaemonConnection,
  DaemonV11ControlPort,
} from '../../host/daemon/daemon-rpc-v11.js';
import type { SessionIndex } from '../../host/daemon/session-index.js';
import type { ModelRef } from '../../model/index.js';
import type { SessionLaunchParams, SettingsUpdateParamsV11 } from '../../protocol/client-api/client-api-schema.js';
import { createDirectMcpRefresh } from '../application-mcp.js';
import type { DirectApplication } from '../application.js';
import { LOCAL_PRINCIPAL, requireLocalCaller } from '../application-workspaces.js';
import type { DirectSessionPolicy } from '../application-runtime.js';
import { ACP_SESSION_POLICY, authorizeAcpModel, type AcpRequest } from './acp-common.js';
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

const weakerApproval = (mode: unknown) => mode === 'auto' || mode === 'unattended';
const unreviewed = () =>
  new ClientApiRpcError(
    'unavailable',
    'Assisted and Unattended approval are not available for ACP sessions over the term2 daemon yet; run term2 acp with TERM2_IN_PROCESS=1 to use them.',
  );
const sandboxRequired = () => new ClientApiRpcError('invalid_request', 'ACP sessions require the sandbox.');

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
  /** Session id to the connection holding it as its ACP client. */
  const holders = new Map<string, string>();
  /** Sessions given MCP servers since they opened, retired managers included. */
  const installed = new Set<string>();
  const watched = new Set<string>();
  const chains = new Map<string, Promise<unknown>>();
  const launching = new AsyncLocalStorage<DaemonConnection | undefined>();
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
    // A session closed meanwhile may have reopened without its holder; never install into it.
    if (!deps.isAcpSession(sessionId)) {
      connection.close();
      throw new ClientApiRpcError('not_found', 'Session is not open as an ACP session.');
    }
    return connection;
  };

  /** Close every MCP process the session had; a session that stays open rebuilds its tools without them when idle. */
  const release = async (sessionId: string, open: boolean): Promise<void> => {
    const had = installed.delete(sessionId);
    await sessions.close(sessionId);
    if (open && had) for (const listener of catalogListeners) listener();
  };

  const watch = (connection: DaemonConnection): void => {
    if (watched.has(connection.connectionId)) return;
    watched.add(connection.connectionId);
    connection.onDisconnect(() => {
      watched.delete(connection.connectionId);
      for (const [sessionId, holder] of holders) {
        if (holder !== connection.connectionId) continue;
        holders.delete(sessionId);
        void serialize(sessionId, () => release(sessionId, true)).catch((error: unknown) =>
          warn(`ACP MCP cleanup for ${sessionId} failed: ${String(error)}`),
        );
      }
    });
  };

  /**
   * Runs after a launch opened or found its session, before any configuration applies.
   * A live session keeps the surface it opened with, so ACP never drives another
   * client's, and one ACP client holds a session at a time (in-process: the writer
   * lock). A new holder starts in Ask, as a new in-process ACP process does. Assisted and
   * Unattended rely on ACP v1's sandboxed-shell review, which a launch cannot ask for
   * (`clientMode` has no ACP version); without it they would run mutating sandboxed
   * commands unreviewed, so no client may put an ACP session in them.
   */
  const admitLaunch = async (sessionId: string, params: SessionLaunchParams): Promise<void> => {
    const acpSession = deps.isAcpSession(sessionId);
    if (params.clientMode !== 'acp') {
      if (acpSession && weakerApproval(params.approvalMode)) throw unreviewed();
      if (acpSession && params.sandboxEnabled === false) throw sandboxRequired();
      return;
    }
    if (!acpSession)
      throw new ClientApiRpcError('busy', 'Session is open for another client; close it before resuming it over ACP.');
    if (weakerApproval(params.approvalMode)) throw unreviewed();
    if (params.sandboxEnabled === false) throw sandboxRequired();
    const connection = launching.getStore();
    if (!connection) throw new ClientApiRpcError('invalid_request', 'ACP sessions need a connection-bound launch.');
    const holder = holders.get(sessionId);
    if (holder === connection.connectionId) return;
    if (holder !== undefined) throw new ClientApiRpcError('busy', 'Session is open in another ACP client.');
    if ((await deps.app.sessionConfiguration(sessionId)).approvalMode !== 'off') {
      try {
        await deps.app.applyLaunchConfiguration(sessionId, {}, 'off');
      } catch (error) {
        throw new ClientApiRpcError('busy', error instanceof Error ? error.message : String(error));
      }
    }
    holders.set(sessionId, connection.connectionId);
    watch(connection);
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
    /**
     * The runtime policy of an ACP session, held for its whole life. `refuseSetting` is the
     * one place that keeps it out of Assisted, Unattended and sandbox-off: every write to
     * the session's settings and every approval-mode configure checks it, whichever
     * client or route (Unix, HTTP, launch) asked.
     */
    sessionPolicy: {
      ...ACP_SESSION_POLICY,
      authorizeModel: (next: ModelRef, previous: ModelRef) =>
        authorizeAcpModel(deps.selection.settings, next, previous),
      refuseSetting(key, value) {
        if (key === 'shell.autoApproveMode' && weakerApproval(value)) throw new Error(unreviewed().message);
        if (key === 'sandbox.enabled' && value !== true) throw new Error(sandboxRequired().message);
      },
    } satisfies DirectSessionPolicy,
    /** A live ACP client holds this session: it reopens only with the ACP surface. */
    holds: (sessionId: string) => holders.has(sessionId),
    admitLaunch,
    /** Launches carry their connection to `admitLaunch`; a settings write may not weaken an ACP session. */
    guardV11(port: DaemonV11ControlPort): Pick<DaemonV11ControlPort, 'launchSession' | 'updateScopedSettings'> {
      return {
        launchSession: (principal, params, connection) =>
          launching.run(connection, () => port.launchSession!(principal, params, connection)),
        updateScopedSettings(principal, params: SettingsUpdateParamsV11) {
          if (params.sessionId && deps.isAcpSession(params.sessionId)) {
            for (const change of params.changes) {
              // A reset restores the saved preference, which may be either.
              const value = 'reset' in change ? undefined : change.value;
              if (change.key === 'shell.autoApproveMode' && (value === undefined || weakerApproval(value)))
                throw unreviewed();
              if (change.key === 'sandbox.enabled' && value !== true) throw sandboxRequired();
            }
          }
          return port.updateScopedSettings!(principal, params);
        },
      };
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
        if (holders.get(sessionId) !== connection.connectionId) {
          throw new ClientApiRpcError(
            'forbidden',
            'Only the ACP client holding this session may change its MCP servers.',
          );
        }
        if (mcpServers.length === 0 && !installed.has(sessionId)) return;
        // Marked first: a holder that disconnects mid-install still releases whatever this starts.
        installed.add(sessionId);
        try {
          const opened = await sessions.open(
            { cwd: await sessionRoot(sessionId), sessionId, mcpServers },
            connect(sessionId),
          );
          opened.close();
        } catch (error) {
          throw rpcError(error);
        }
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
      holders.clear();
    },
  };
}
