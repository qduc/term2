/**
 * The MCP connection layer: owns one connection per configured server and
 * exposes them through {@linkcode McpToolSource} (the fixed contract with the
 * `run_code` script surface).
 *
 * Lifecycle: `start()` connects every server concurrently in the background
 * (connecting → ready/failed); `snapshot()` keeps a stable array identity until
 * something actually changes; `notifications/tools/list_changed` triggers a
 * refetch; `close()` shuts everything down. There is no automatic reconnect in
 * this slice — a failed server stays failed until the next `start()`.
 */
import {
  Client,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpCallError } from './mcp-tool-source.js';
import type { McpServerSnapshot, McpToolDescriptor, McpToolSource } from './mcp-tool-source.js';

export { McpCallError };
import { realpathOrSelf, type ResolvedMcpServerConfig } from './mcp-config.js';
import { unsandboxedStdioLauncher, type StdioLauncher } from './mcp-stdio-launcher.js';

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const STDERR_TAIL_CHARS = 2000;
const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 15_000;
/** Upper bound on waiting for a client/transport close during `close()`. */
const CLOSE_TIMEOUT_MS = 5_000;

export interface McpConnectionManagerOptions {
  servers: readonly ResolvedMcpServerConfig[];
  /** Path of the user config file, cited in the project-stdio opt-in error. */
  userConfigPath?: string;
  /** This session's workspace root, cited in the project-stdio opt-in error. */
  workspaceRoot?: string;
  /** Where stdio servers are actually spawned. Defaults to an unsandboxed spawn. */
  stdioLauncher?: StdioLauncher;
}

type ConnectionState = 'connecting' | 'ready' | 'failed';

interface Connection {
  readonly config: ResolvedMcpServerConfig;
  state: ConnectionState;
  error?: string;
  tools: McpToolDescriptor[];
  client?: Client;
  transport?: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  stderrTail?: string;
  /** Set while the manager is closing, so transport close is not a crash. */
  closing?: boolean;
}

/** The exact nested line a user must add to start a project stdio server. */
const projectOptInError = (
  name: string,
  workspaceRoot: string | undefined,
  userConfigPath: string | undefined,
): string =>
  `project stdio server "${name}" was not started: it must be enabled for this workspace by adding \`"projectServers": { "${
    workspaceRoot ?? '<workspace root>'
  }": { "${name}": { "enabled": true } } }\` to ${userConfigPath ?? 'the user mcp.json'}`;

export class McpConnectionManager implements McpToolSource {
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<() => void>();
  private readonly stdioLauncher: StdioLauncher;
  private readonly userConfigPath?: string;
  private readonly workspaceRoot?: string;
  private snapshotCache: readonly McpServerSnapshot[] = [];
  private started = false;
  private closed = false;
  private settlePromise: Promise<void> = Promise.resolve();

  constructor(options: McpConnectionManagerOptions) {
    this.stdioLauncher = options.stdioLauncher ?? unsandboxedStdioLauncher;
    this.userConfigPath = options.userConfigPath;
    this.workspaceRoot = options.workspaceRoot;
    for (const config of options.servers) {
      if (this.connections.has(config.name)) {
        this.connections.set(config.name, {
          config,
          state: 'failed',
          tools: [],
          error: `duplicate server name "${config.name}" in resolved config`,
        });
        continue;
      }
      this.connections.set(config.name, { config, state: 'connecting', tools: [] });
    }
    this.rebuildSnapshot();
  }

  /** Begins connecting every server concurrently. Resolved configs never throw. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const settling = Array.from(this.connections.values(), (connection) => this.connectOne(connection));
    this.settlePromise = Promise.all(settling).then(() => undefined);
  }

  /** Resolves once every connection started by `start()` left `connecting`. */
  whenSettled(): Promise<void> {
    return this.settlePromise;
  }

  snapshot(): readonly McpServerSnapshot[] {
    return this.snapshotCache;
  }

  onCatalogChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; timeoutMs?: number },
  ): Promise<{ content: readonly unknown[]; structuredContent?: unknown; isError: boolean }> {
    const connection = this.connections.get(server);
    if (!connection) throw new McpCallError('unknown_server', `no MCP server named "${server}"`);
    if (connection.state !== 'ready' || !connection.client) {
      throw new McpCallError(
        'server_unavailable',
        `server "${server}" is ${connection.state}${connection.error ? ` (${connection.error})` : ''}`,
      );
    }
    if (!connection.tools.some((t) => t.name === tool)) {
      throw new McpCallError('unknown_tool', `server "${server}" does not list a tool named "${tool}"`);
    }
    if (options.signal.aborted) throw new McpCallError('aborted', 'call aborted before it was sent');

    try {
      const result = await connection.client.callTool(
        { name: tool, arguments: args },
        { signal: options.signal, timeout: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS },
      );
      return {
        content: result.content ?? [],
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        isError: result.isError === true,
      };
    } catch (error) {
      throw this.mapCallError(server, tool, options.signal, error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      Array.from(this.connections.values(), async (connection) => {
        connection.closing = true;
        // The grace timer is cleared (and unref'd) as soon as teardown wins,
        // so a finished close() never keeps the event loop alive.
        let grace: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.teardown(connection),
            new Promise<void>((resolve) => {
              grace = setTimeout(resolve, CLOSE_TIMEOUT_MS);
              grace.unref?.();
            }),
          ]);
        } finally {
          if (grace !== undefined) clearTimeout(grace);
        }
      }),
    );
  }

  /**
   * Closes and clears this connection's client and transport, waiting for the
   * closes to finish (bounded by the caller). Clearing first means a close()
   * racing an in-flight connect can never double-close or re-await a torn-down
   * client, and connectOne's post-await checks see the cleared state.
   */
  private async teardown(connection: Connection): Promise<void> {
    const { client, transport } = connection;
    connection.client = undefined;
    connection.transport = undefined;
    await Promise.all([client?.close().catch(() => {}), transport?.close().catch(() => {})]);
  }

  /** True once close() ran or this connection is being torn down. */
  private isAbandoned(connection: Connection): boolean {
    return this.closed || connection.closing === true;
  }

  private mapCallError(server: string, tool: string, signal: AbortSignal, error: unknown): McpCallError {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return new McpCallError('aborted', `call to ${server}.${tool} was aborted`);
    }
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
      return new McpCallError('timeout', `call to ${server}.${tool} exceeded its timeout`);
    }
    // A crash or teardown mid-call kills the transport and (soon after) moves
    // the connection out of `ready`; either signal means the server, not the
    // protocol, is gone.
    const connection = this.connections.get(server);
    const connectionLost = connection !== undefined && connection.state !== 'ready' && !this.isAbandoned(connection);
    const transportClosed =
      error instanceof SdkError &&
      (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected);
    if (connectionLost || transportClosed) {
      return new McpCallError(
        'server_unavailable',
        `server "${server}" is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new McpCallError('protocol', `call to ${server}.${tool} failed: ${message}`);
  }

  private async connectOne(connection: Connection): Promise<void> {
    const { config } = connection;
    if (this.isAbandoned(connection)) return;
    try {
      if (config.error !== undefined) {
        this.markFailed(connection, config.error);
        return;
      }
      if (config.transport === 'stdio' && config.provenance === 'project' && config.projectEnabledOverride !== true) {
        this.markFailed(
          connection,
          projectOptInError(config.name, realpathOrSelf(this.workspaceRoot ?? ''), this.userConfigPath),
        );
        return;
      }
      if (config.transport === 'stdio') {
        await this.connectStdio(connection);
      } else {
        await this.connectHttp(connection);
      }
      // Re-check after every await: close() may have fired while we were
      // launching or connecting. Anything just created is torn down, and the
      // connection never becomes `ready` or notifies after close.
      if (this.isAbandoned(connection)) {
        await this.teardown(connection);
        return;
      }
      await this.refreshTools(connection, { cache: 'use' });
      if (this.isAbandoned(connection)) {
        await this.teardown(connection);
        return;
      }
      connection.state = 'ready';
      this.rebuildSnapshot();
    } catch (error) {
      // A failure after spawn/connect must not leak the process or transport.
      await this.teardown(connection);
      // The failure may itself be caused by close() aborting the connect;
      // never record a failure or notify after close.
      if (this.isAbandoned(connection)) return;
      const detail = error instanceof Error ? error.message : String(error);
      const tail = connection.stderrTail ? ` stderr: ${connection.stderrTail}` : '';
      this.markFailed(connection, `${detail}${tail}`);
    }
  }

  private async connectStdio(connection: Connection): Promise<void> {
    const { config } = connection;
    const spawned = await this.stdioLauncher({
      name: config.name,
      command: config.command ?? '',
      args: config.args ?? [],
      env: config.env ?? {},
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    });
    // The launcher may have resolved after close() started: never spawn then.
    if (this.isAbandoned(connection)) return;
    const transport = new StdioClientTransport({
      command: spawned.command,
      args: [...spawned.args],
      env: { ...spawned.env },
      ...(spawned.cwd !== undefined ? { cwd: spawned.cwd } : {}),
      stderr: 'pipe',
    });
    // Registered on the connection before connecting, so a close() that
    // fires mid-handshake can always reach the transport and kill the child.
    connection.transport = transport;
    this.watchStdio(connection, transport);
    await this.connectClient(connection, transport);
  }

  private async connectHttp(connection: Connection): Promise<void> {
    const { config } = connection;
    if (config.url === undefined) throw new Error('http/sse server has no url');
    const headers = config.headers ?? {};
    const url = new URL(config.url);
    const transport =
      config.transport === 'sse'
        ? new SSEClientTransport(url, { requestInit: { headers } })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    // Stored like stdio so teardown is uniform across transports.
    connection.transport = transport;
    // Known gap: HTTP/SSE transports do not observe a dropped remote session
    // (no onclose signal we can rely on here), so such a server stays `ready`
    // until a call fails. Not handled in this slice.
    await this.connectClient(connection, transport);
  }

  private async connectClient(
    connection: Connection,
    transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport,
  ): Promise<void> {
    const client = new Client({ name: 'term2', version: '0.0.0' });
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      void this.handleListChanged(connection);
    });
    connection.client = client;
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  }

  private watchStdio(connection: Connection, transport: StdioClientTransport): void {
    let tail = '';
    transport.onclose = () => {
      if (connection.closing || this.closed) return;
      // A stdio process exiting is terminal for that connection.
      this.markFailed(
        connection,
        `stdio server process exited${connection.stderrTail ? `. stderr tail: ${connection.stderrTail}` : ''}`,
      );
    };
    transport.stderr?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
      connection.stderrTail = tail;
    });
  }

  private async handleListChanged(connection: Connection): Promise<void> {
    if (connection.state !== 'ready' || this.isAbandoned(connection)) return;
    try {
      await this.refreshTools(connection, { cache: 'refresh' });
      if (this.isAbandoned(connection)) return;
      this.rebuildSnapshot();
    } catch (error) {
      // close() aborts the in-flight list; that rejection is not a failure.
      if (this.isAbandoned(connection)) return;
      const detail = error instanceof Error ? error.message : String(error);
      this.markFailed(connection, `tools/list after list_changed failed: ${detail}`);
    }
  }

  private async refreshTools(connection: Connection, options: { cache: 'use' | 'refresh' }): Promise<void> {
    const client = connection.client;
    if (!client) throw new Error('no client');
    // No cursor: the client walks every page and returns the merged catalog.
    const result = await client.listTools(undefined, { ...options, timeout: LIST_TIMEOUT_MS });
    connection.tools = result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    }));
  }

  private markFailed(connection: Connection, error: string): void {
    // A closed manager never changes state or notifies listeners.
    if (this.isAbandoned(connection)) return;
    connection.state = 'failed';
    connection.error = error;
    connection.tools = [];
    this.rebuildSnapshot();
  }

  private rebuildSnapshot(): void {
    const next: McpServerSnapshot[] = Array.from(this.connections.values(), (connection) => ({
      name: connection.config.name,
      provenance: connection.config.provenance,
      transport: connection.config.transport,
      state: connection.state,
      ...(connection.error !== undefined ? { error: connection.error } : {}),
      tools: connection.tools,
    }));
    if (JSON.stringify(next) === JSON.stringify(this.snapshotCache)) return;
    this.snapshotCache = next;
    for (const listener of this.listeners) listener();
  }
}
