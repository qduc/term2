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
import type { ResolvedMcpServerConfig } from './mcp-config.js';
import { unsandboxedStdioLauncher, type StdioLauncher } from './mcp-stdio-launcher.js';

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const STDERR_TAIL_CHARS = 2000;
const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 15_000;

export interface McpConnectionManagerOptions {
  servers: readonly ResolvedMcpServerConfig[];
  /** Path of the user config file, cited in the project-stdio opt-in error. */
  userConfigPath?: string;
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
  transport?: StdioClientTransport;
  stderrTail?: string;
  /** Set while the manager is closing, so transport close is not a crash. */
  closing?: boolean;
}

/** The exact line a user must add to start a project stdio server. */
const projectOptInError = (name: string, userConfigPath: string | undefined): string =>
  `project stdio server "${name}" was not started: it must be enabled by adding \`"projectServers": { "${name}": { "enabled": true } }\` to ${
    userConfigPath ?? 'the user mcp.json'
  }`;

export class McpConnectionManager implements McpToolSource {
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<() => void>();
  private readonly stdioLauncher: StdioLauncher;
  private readonly userConfigPath?: string;
  private snapshotCache: readonly McpServerSnapshot[] = [];
  private started = false;
  private closed = false;
  private settlePromise: Promise<void> = Promise.resolve();

  constructor(options: McpConnectionManagerOptions) {
    this.stdioLauncher = options.stdioLauncher ?? unsandboxedStdioLauncher;
    this.userConfigPath = options.userConfigPath;
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
        connection.client?.close().catch(() => {});
        connection.transport?.close().catch(() => {});
      }),
    );
  }

  private mapCallError(server: string, tool: string, signal: AbortSignal, error: unknown): McpCallError {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return new McpCallError('aborted', `call to ${server}.${tool} was aborted`);
    }
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
      return new McpCallError('timeout', `call to ${server}.${tool} exceeded its timeout`);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new McpCallError('protocol', `call to ${server}.${tool} failed: ${message}`);
  }

  private async connectOne(connection: Connection): Promise<void> {
    const { config } = connection;
    try {
      if (this.closed || connection.closing) return;
      if (config.error !== undefined) {
        this.markFailed(connection, config.error);
        return;
      }
      if (config.transport === 'stdio' && config.provenance === 'project' && config.projectEnabledOverride !== true) {
        this.markFailed(connection, projectOptInError(config.name, this.userConfigPath));
        return;
      }
      if (config.transport === 'stdio') {
        await this.connectStdio(connection);
      } else {
        await this.connectHttp(connection);
      }
      await this.refreshTools(connection, { cache: 'use' });
      connection.state = 'ready';
      this.rebuildSnapshot();
    } catch (error) {
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
    const transport = new StdioClientTransport({
      command: spawned.command,
      args: [...spawned.args],
      env: { ...spawned.env },
      ...(spawned.cwd !== undefined ? { cwd: spawned.cwd } : {}),
      stderr: 'pipe',
    });
    this.watchStdio(connection, transport);
    connection.transport = transport;
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
    if (connection.state !== 'ready' || connection.closing || this.closed) return;
    try {
      await this.refreshTools(connection, { cache: 'refresh' });
      this.rebuildSnapshot();
    } catch (error) {
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
