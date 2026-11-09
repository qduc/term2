/** ACP-supplied MCP connections belong to one session, never to global settings. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import type { AcpSessionSetup } from '../clients/acp/contract.js';
import type { DirectConnection } from '../host/in-process-direct-types.js';
import type { WireNativeCommandOutcome } from '../protocol/wire.js';
import { McpConnectionManager } from '../tools/mcp/mcp-connection-manager.js';
import type { ResolvedMcpServerConfig } from '../tools/mcp/mcp-config.js';
import { McpCallError, type McpToolSource } from '../tools/mcp/mcp-tool-source.js';
import { captureDirectMcpSource } from './mcp-source.js';

type Resource = {
  readonly servers: NonNullable<AcpSessionSetup['mcpServers']>;
  readonly manager: McpConnectionManager;
  unsubscribe?: () => void;
};
const empty: McpToolSource = {
  snapshot: () => [],
  onCatalogChanged: () => () => {},
  callTool: async () => {
    throw new McpCallError('unknown_server', 'No ACP MCP server is configured');
  },
};

/** Validate the entire list before connecting anything; never expand client env or persist secrets. */
function configs(request: AcpSessionSetup): ResolvedMcpServerConfig[] {
  const names = new Set<string>();
  return (request.mcpServers ?? []).map((server) => {
    if (!server.name.trim() || names.has(server.name))
      throw acp.RequestError.invalidParams(undefined, 'MCP server names must be nonempty and unique');
    names.add(server.name);
    if (!('type' in server)) {
      if (!server.command.trim()) throw acp.RequestError.invalidParams(undefined, 'MCP stdio command must be nonempty');
      const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]));
      return {
        name: server.name,
        provenance: 'user',
        transport: 'stdio',
        command: server.command,
        args: server.args,
        env,
        cwd: request.cwd,
      };
    }
    if (server.type !== 'http' && server.type !== 'sse')
      throw acp.RequestError.invalidParams(undefined, 'Unsupported MCP transport');
    return {
      name: server.name,
      provenance: 'user',
      transport: server.type === 'http' ? 'streamable-http' : 'sse',
      url: server.url,
      headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
    };
  });
}

/** Rebuild through one exact native receipt; admission is not installation evidence. */
async function refresh(connection: DirectConnection): Promise<void> {
  const commandId = randomUUID();
  const result = await connection.send({
    type: 'configure',
    commandId,
    configuration: { model: connection.snapshot.model },
  });
  if (!result.ok) throw new acp.RequestError(-32010, result.message);
  let outcome: WireNativeCommandOutcome | undefined =
    result.kind === 'command_finished' ? result.receipt.outcome : undefined;
  if (result.kind === 'command_pending') {
    for await (const event of connection.events) {
      if (event.type === 'command_finished' && event.payload.receipt.request.commandId === commandId) {
        outcome = event.payload.receipt.outcome;
        break;
      }
    }
  }
  if (outcome?.kind !== 'configured')
    throw new acp.RequestError(
      -32010,
      outcome?.kind === 'rejected' ? outcome.message : 'MCP tool configuration was not confirmed',
    );
}

/**
 * Own session MCP processes and immutable offered catalogs. Preparation is scoped
 * to the creating/configuring async operation; unrelated sessions/configures
 * cannot capture an unaccepted candidate. Retired managers stay alive with old
 * tool generations until explicit session close or application shutdown drains
 * native work. No provider tool or approval bypass is added: calls use run_code.
 */
export function createAcpSessions() {
  const current = new Map<string, Resource>();
  const retired = new Map<string, Set<Resource>>();
  const opening = new Set<Resource>();
  const operations = new Set<Promise<void>>();
  const listeners = new Set<() => void>();
  const preparation = new AsyncLocalStorage<{ sessionId?: string; resource: Resource }>();
  let stopped = false;
  const dispose = async (resource: Resource) => {
    resource.unsubscribe?.();
    await resource.manager.close();
  };
  const close = async (sessionId: string) => {
    const resources = new Set(retired.get(sessionId));
    const active = current.get(sessionId);
    if (active) resources.add(active);
    current.delete(sessionId);
    retired.delete(sessionId);
    await Promise.all([...resources].map(dispose));
  };
  const drain = async () => {
    stopped = true;
    await Promise.all([...operations]);
  };
  return {
    surface(sessionId: string) {
      return {
        captureRequest() {
          const pending = preparation.getStore();
          const resource =
            pending && (!pending.sessionId || pending.sessionId === sessionId)
              ? pending.resource
              : current.get(sessionId);
          if (!resource) return captureDirectMcpSource(empty, []);
          const { manager } = resource;
          return captureDirectMcpSource(
            {
              // Startup errors can include subprocess stderr or HTTP response bodies.
              snapshot: () => manager.snapshot().map(({ error: _error, ...server }) => server),
              callTool: (...args) => manager.callTool(...args),
              onCatalogChanged: (listener) => manager.onCatalogChanged(listener),
            },
            [],
          );
        },
      };
    },
    onCatalogChanged(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async open(request: AcpSessionSetup, connect: () => Promise<DirectConnection>): Promise<DirectConnection> {
      if (stopped) throw new acp.RequestError(-32010, 'ACP session resources are closed');
      const servers = request.mcpServers ?? [];
      const resolved = configs(request);
      const previous = request.sessionId ? current.get(request.sessionId) : undefined;
      const resource: Resource = {
        servers,
        manager: new McpConnectionManager({
          servers: resolved,
          workspaceRoot: request.cwd,
          interactive: false,
          httpRedirect: 'error',
        }),
      };
      let settle!: () => void;
      const operation = new Promise<void>((resolve) => {
        settle = resolve;
      });
      operations.add(operation);
      opening.add(resource);
      let connection: DirectConnection | undefined;
      let adopted = false;
      try {
        if (previous && isDeepStrictEqual(previous.servers, servers)) {
          connection = await connect();
          if (stopped) throw new acp.RequestError(-32010, 'ACP session resources are closed');
          return connection;
        }
        resource.manager.start();
        await resource.manager.whenSettled();
        if (stopped) throw new acp.RequestError(-32010, 'ACP session resources are closed');
        const failed = resource.manager.snapshot().find((server) => server.state !== 'ready');
        // An unavailable optional server must not block opening a session.
        // Replacing an existing catalog remains atomic.
        if (previous && failed) throw new acp.RequestError(-32010, `Could not connect MCP server: ${failed.name}`);
        return await preparation.run({ sessionId: request.sessionId, resource }, async () => {
          connection = await connect();
          if (request.sessionId) {
            await refresh(connection);
          }
          const sessionId = connection.sessionId;
          if (previous) {
            previous.unsubscribe?.();
            const held = retired.get(sessionId) ?? new Set<Resource>();
            held.add(previous);
            retired.set(sessionId, held);
          }
          current.set(sessionId, resource);
          adopted = true;
          resource.unsubscribe = resource.manager.onCatalogChanged(() => {
            for (const listener of listeners) listener();
          });
          if (stopped) throw new acp.RequestError(-32010, 'ACP session resources are closed');
          if (request.sessionId) {
            connection.close();
            connection = await connect();
            if (stopped) throw new acp.RequestError(-32010, 'ACP session resources are closed');
          }
          return connection;
        });
      } catch (error) {
        connection?.close();
        // A confirmed native generation may already hold this source. Keep it
        // until native drain even if obtaining its fresh view subsequently fails.
        if (!adopted) await dispose(resource);
        throw error;
      } finally {
        opening.delete(resource);
        operations.delete(operation);
        settle();
      }
    },
    close,
    drain,
    async shutdown() {
      await drain();
      await Promise.all([...new Set([...current.keys(), ...retired.keys()])].map(close));
      await Promise.all([...opening].map(dispose));
      listeners.clear();
    },
  };
}
