/**
 * `term2 acp` as a client of the singleton daemon (Step 14e Part 2b). stdout stays the
 * ACP channel; the daemon hosts the sessions.
 *
 * Every ACP session is opened through `session.launch` with `clientMode: 'acp'`, so the
 * daemon builds it with in-process ACP's posture (Ask mode, required sandbox, no
 * unsandboxed shell, no session browser, configuration kept out of saved defaults,
 * model moves limited to configured catalogs) and refuses to resume a session that is
 * already live under another client's surface. MCP servers the ACP client supplies run
 * inside the daemon through `session.acp.set_mcp`, owned by this connection: when this
 * process ends, the daemon closes them.
 */
import fs from 'node:fs';
import * as acp from '@agentclientprotocol/sdk';
import type { McpServer } from '@agentclientprotocol/sdk';
import { installationVersion } from '../../model/providers/fetch/logging-middleware.js';
import { createAcpBackend, createStdioAcpIo, serveAcp, type AcpWorkspaces } from '../../clients/acp/index.js';
import type { AcpSessionSetup } from '../../clients/acp/contract.js';
import { ClientApiRpcError } from '../../host/daemon/daemon-errors.js';
import type { RemoteDirectHost } from '../../host/daemon/remote-direct-host.js';
import type { DirectConnection, DirectHost } from '../../host/in-process-direct-types.js';
import type { SessionLaunchParams } from '../../protocol/client-api/client-api-schema.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import { LOCAL_PRINCIPAL, localGrant } from '../application-workspaces.js';
import { connectRemoteDirectHost } from '../daemon/connect-daemon-host.js';
import { warnIfSandboxUnavailable } from '../sandbox-warning.js';
import {
  acpApprovalMode,
  applyAcpModelFlags,
  createAcpModelCatalog,
  nativeApprovalMode,
  type AcpModelFlags,
  type AcpRequest,
} from './acp-common.js';
import { resolveAcpMcpServers } from './acp-sessions.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Daemon refusals keep the shape in-process ACP reports for the same case. */
function fromRpc(error: unknown): unknown {
  if (!(error instanceof ClientApiRpcError)) return error;
  switch (error.code) {
    case 'not_found':
      return new DirectProtocolError('not_found', error.message);
    case 'invalid_request':
      return acp.RequestError.invalidParams(undefined, error.message);
    case 'forbidden':
    case 'unauthorized':
      return new DirectProtocolError('forbidden', error.message);
    default:
      // Operational failures: v1 reports them as -32010, as for an MCP server that will not start.
      return new acp.RequestError(-32000, error.message);
  }
}

async function rpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw fromRpc(error);
  }
}

/**
 * The stdio servers' default variables come from this process, as in-process ACP's MCP
 * SDK reads them: the daemon's own HOME, PATH and the rest may differ, and the server
 * gets no other variable from either process.
 */
async function withClientEnvironment(servers: readonly McpServer[]): Promise<McpServer[]> {
  if (servers.every((server) => 'type' in server)) return [...servers];
  const { getDefaultEnvironment } = await import('@modelcontextprotocol/client/stdio');
  const defaults = Object.entries(getDefaultEnvironment());
  return servers.map((server) => {
    if ('type' in server) return server;
    const named = new Set(server.env.map(({ name }) => name));
    const inherited = defaults.filter(([name]) => !named.has(name)).map(([name, value]) => ({ name, value }));
    return { ...server, env: [...inherited, ...server.env] };
  });
}

type SettingsEntries = Readonly<Record<string, { readonly value?: unknown } | undefined>>;

async function sessionSettings(host: RemoteDirectHost, sessionId: string): Promise<SettingsEntries> {
  const read = await rpc(() => host.readSettings({ view: 'tui', sessionId }));
  const settings = read['settings'] as { readonly entries?: SettingsEntries } | undefined;
  return settings?.entries ?? {};
}

function acpDaemonClient(host: RemoteDirectHost, flags: AcpModelFlags) {
  const roots = new Map<string, string>();
  const installed = new Set<string>();
  const operations = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => undefined);
    return operation;
  };
  const sessionRoot = async (sessionId: string): Promise<string> => {
    const known = roots.get(sessionId);
    if (known) return known;
    let cursor: string | undefined;
    do {
      const page = await host.listSessions(LOCAL_PRINCIPAL, cursor);
      const session = page.sessions.find(({ id }) => id === sessionId);
      if (session) return session.workspace.root;
      cursor = page.cursor;
    } while (cursor !== undefined);
    throw new DirectProtocolError('not_found', 'Unknown direct session.');
  };
  const launch = async (params: SessionLaunchParams): Promise<string> => {
    const launched = await rpc(() => host.launchSession(params));
    roots.set(launched.session.id, launched.workspace.root);
    return launched.session.id;
  };
  /** Opens or re-admits an existing session with the ACP surface before attaching. */
  const resume = (sessionId: string, cwd: string, extra: Pick<SessionLaunchParams, 'approvalMode'> = {}) =>
    launch({ cwd, selection: { kind: 'resume', sessionId }, clientMode: 'acp', ...extra });

  const directHost: DirectHost = {
    listSessions: (principal, cursor) => host.listSessions(principal, cursor),
    async createSession(_principal, grant) {
      const sessionId = await launch({
        cwd: grant.workspaceId,
        selection: { kind: 'new' },
        clientMode: 'acp',
        requireSandbox: true,
        ...(flags.model ? { model: flags.model } : {}),
        ...(flags.reasoning ? { reasoning: flags.reasoning } : {}),
      });
      return await host.connect(LOCAL_PRINCIPAL, sessionId);
    },
    connect: host.connect,
    closeSession: (principal, sessionId) => host.closeSession!(principal, sessionId),
    dispose: () => host.dispose(),
  };

  const sessions = {
    open(request: AcpSessionSetup, connect: () => Promise<DirectConnection>): Promise<DirectConnection> {
      return track(
        (async () => {
          const supplied = request.mcpServers ?? [];
          // The same validation as in-process ACP, before anything is created.
          resolveAcpMcpServers({ ...request, mcpServers: supplied });
          if (request.sessionId) await resume(request.sessionId, request.cwd);
          let connection = await connect();
          const { sessionId } = connection;
          if (supplied.length === 0 && !installed.has(sessionId)) return connection;
          try {
            const servers = await withClientEnvironment(supplied);
            await rpc(() =>
              host.rpc.request('session.acp.set_mcp', { sessionId, servers: servers as Record<string, unknown>[] }),
            );
            if (servers.length) installed.add(sessionId);
            else installed.delete(sessionId);
            // A fresh view, as in-process ACP takes after installing a catalog.
            connection.close();
            connection = await host.connect(LOCAL_PRINCIPAL, sessionId);
            return connection;
          } catch (error) {
            connection.close();
            // A session this request created never existed for the ACP client.
            if (!request.sessionId) await host.closeSession!(LOCAL_PRINCIPAL, sessionId).catch(() => undefined);
            throw error;
          }
        })(),
      );
    },
    async close(sessionId: string): Promise<void> {
      // The daemon closes a session's MCP servers with the session.
      installed.delete(sessionId);
    },
  };

  const workspaces: AcpWorkspaces = {
    async authorize(cwd) {
      return localGrant(fs.realpathSync(cwd));
    },
    cwd: sessionRoot,
  };

  return {
    directHost,
    sessions,
    workspaces,
    async approvalMode(sessionId: string) {
      return acpApprovalMode((await sessionSettings(host, sessionId))['shell.autoApproveMode']?.value);
    },
    async setApprovalMode(sessionId: string, mode: keyof typeof nativeApprovalMode) {
      await resume(sessionId, await sessionRoot(sessionId), { approvalMode: nativeApprovalMode[mode] });
    },
    async configuration(sessionId: string) {
      const entries = await sessionSettings(host, sessionId);
      const model = entries['agent.modelSelection']?.value as { provider?: unknown; model?: unknown } | undefined;
      const reasoning = entries['agent.reasoningEffort']?.value;
      if (typeof model?.provider !== 'string' || typeof model.model !== 'string' || typeof reasoning !== 'string')
        throw new Error('Session configuration is unavailable.');
      return { model: { provider: model.provider, model: model.model }, reasoning: reasoning as never };
    },
    drain: () => Promise.allSettled([...operations]),
  };
}

export async function launchAcpOverDaemon(request: AcpRequest): Promise<number> {
  const io = createStdioAcpIo();
  const flags = await applyAcpModelFlags(request, io);
  if (!flags) return 1;
  await warnIfSandboxUnavailable('acp', (line) => io.writeStderr(line));

  const { conversationsDir, selection } = request;
  let host: RemoteDirectHost;
  try {
    const connected = await connectRemoteDirectHost({
      clientKind: 'acp',
      conversationsDir,
      protocolVersion: '1.1',
      minSupportedVersion: '1.1',
      env: process.env,
    });
    host = connected.host;
    if (!connected.welcome.capabilities.includes('local_leases')) {
      await host.dispose();
      io.writeStderr('term2 acp: the running term2 daemon does not offer ACP sessions; restart it with this version.');
      return 1;
    }
  } catch (error) {
    io.writeStderr(`term2 acp: cannot reach the term2 daemon: ${messageOf(error)}`);
    return 1;
  }

  const shutdown = new AbortController();
  const onSignal = (): void => shutdown.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let exitCode = 1;
  let protocolVersion: 1 | 2 = 2;
  const client = acpDaemonClient(host, flags);
  try {
    const logger = {
      error: (message: string, fields: Readonly<Record<string, unknown>>) => selection.logger.error(message, fields),
    };
    const backend = createAcpBackend({
      host: client.directHost,
      principal: LOCAL_PRINCIPAL,
      workspaces: client.workspaces,
      logger,
      models: createAcpModelCatalog(selection, shutdown.signal),
      sessions: client.sessions,
      approval: {
        get: (sessionId) => client.approvalMode(sessionId),
        async set(sessionId, mode) {
          if (protocolVersion !== 1) throw new Error('Approval mode is available only in ACP v1.');
          await client.setApprovalMode(sessionId, mode);
        },
      },
      configuration: (sessionId) => client.configuration(sessionId),
    });
    exitCode = await serveAcp(
      {
        backend,
        logger,
        version: installationVersion,
        onProtocolVersion: (version) => {
          protocolVersion = version;
        },
      },
      io,
      shutdown.signal,
    );
  } finally {
    shutdown.abort();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // Sessions stay in the daemon; closing the connection releases this client's MCP servers there.
    await client.drain();
    await host.dispose();
  }
  return exitCode;
}
