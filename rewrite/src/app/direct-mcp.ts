/** Real direct MCP connections, with no Session/runtime, log or credential store of their own. */
import { isAbsolute } from 'node:path';
import { loadMcpConfig } from '../../../source/services/mcp/mcp-config.js';
import { McpConnectionManager } from '../../../source/services/mcp/mcp-connection-manager.js';
import type { McpServerSnapshot } from '../../../source/services/mcp/mcp-tool-source.js';
import type { McpStatusView } from '../../../source/services/mcp/mcp-status.js';
import type { Workspace } from '../tools/index.js';
import { captureDirectMcpSource, type DirectMcpRequestScope } from './direct-mcp-source.js';
import type { DirectMcpOAuth } from './direct-mcp-auth.js';

export { createDirectMcpOAuth, type DirectMcpOAuth } from './direct-mcp-auth.js';
export type { DirectMcpApprovalPolicy, DirectMcpRequestScope } from './direct-mcp-source.js';

export type DirectMcpOptions = {
  readonly workspace: Workspace;
  /** MCP config directory only; never used as an implicit OAuth credential path. */
  readonly settingsDir?: string;
  readonly interactive: boolean;
  /** Explicit credential authority; absent means no stored OAuth tokens are read or written. */
  readonly oauth?: DirectMcpOAuth;
  readonly onNotice?: (message: string) => void;
};
export type DirectMcp = {
  readonly userConfigPath: string;
  readonly notes: readonly string[];
  /** Explicit activation. Loading config alone never spawns or connects. */
  start(): void;
  /** Source startup settlement, not a claim that all servers are ready. */
  whenSettled(): Promise<void>;
  snapshot(): readonly McpServerSnapshot[];
  status(): McpStatusView;
  onCatalogChanged(listener: () => void): () => void;
  captureRequest(): DirectMcpRequestScope;
  /** Returns the real resting state, which may still be failed or needs-auth. */
  reconnect(name: string): Promise<McpServerSnapshot>;
  /** Local interactive command only. Resolves only after the server is actually ready. */
  login(name: string, onAuthorizationUrl?: (url: string) => void, signal?: AbortSignal): Promise<McpServerSnapshot>;
  close(): Promise<void>;
};

/**
 * Load this authorized local workspace's real MCP config and assemble its clean
 * source manager. App owns one instance per authorized local workspace across sessions and configured surface generations;
 * close it only after all root/branch tool work has drained. No default credential
 * file is touched, no new writer is created, and SSH never reads a local project
 * file pretending to be remote config.
 */
export async function createDirectMcp(options: DirectMcpOptions): Promise<DirectMcp> {
  if (options.workspace.target !== 'local') throw new Error('Direct MCP is unavailable for SSH workspaces.');
  if (!isAbsolute(options.workspace.root))
    throw new Error('Direct MCP requires an authorized absolute workspace root.');
  const config = await loadMcpConfig({
    workspaceRoot: options.workspace.root,
    ...(options.settingsDir !== undefined ? { settingsDir: options.settingsDir } : {}),
    ...(options.onNotice ? { onNote: options.onNotice } : {}),
  });
  const manager = new McpConnectionManager({
    servers: config.servers,
    userConfigPath: config.userConfigPath,
    workspaceRoot: options.workspace.root,
    interactive: options.interactive && options.oauth?.login !== undefined,
    ...(options.oauth ? { oauthStore: options.oauth.store } : {}),
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
  });
  const lifetime = new AbortController();
  const pendingLogins = new Set<Promise<McpServerSnapshot>>();
  let closing: Promise<void> | undefined;
  const open = (): void => {
    if (lifetime.signal.aborted) throw new Error('Direct MCP connections are closed.');
  };
  const server = (name: string): McpServerSnapshot => {
    const snapshot = manager.snapshot().find((entry) => entry.name === name);
    if (!snapshot) throw new Error(`No MCP server named "${name}" is configured.`);
    return snapshot;
  };
  const login = async (
    name: string,
    onAuthorizationUrl?: (url: string) => void,
    signal?: AbortSignal,
  ): Promise<McpServerSnapshot> => {
    open();
    if (!options.interactive || !options.oauth?.login)
      throw new Error('MCP login requires an explicit local interactive credential/browser owner.');
    const target = manager.oauthTarget(name);
    if (!target) {
      server(name);
      throw new Error(
        `MCP server "${name}" is not eligible for OAuth; check transport and workspace-scoped user opt-in.`,
      );
    }
    const linked = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    await options.oauth.login(target, linked, onAuthorizationUrl);
    linked.throwIfAborted();
    await manager.reconnect(name);
    linked.throwIfAborted();
    const connected = server(name);
    if (connected.state !== 'ready')
      throw new Error(
        `OAuth login completed, but MCP server "${name}" is ${connected.state}: ${connected.error ?? 'not connected'}`,
      );
    return connected;
  };
  return {
    userConfigPath: config.userConfigPath,
    notes: config.notes,
    start() {
      open();
      manager.start();
    },
    whenSettled: () => manager.whenSettled(),
    snapshot: () => manager.snapshot(),
    status: () => ({ snapshots: manager.snapshot(), userConfigPath: config.userConfigPath }),
    onCatalogChanged: (listener) => manager.onCatalogChanged(listener),
    captureRequest() {
      open();
      return captureDirectMcpSource(manager, config.nonInteractiveAllow);
    },
    async reconnect(name) {
      open();
      server(name);
      await manager.reconnect(name);
      open();
      return server(name);
    },
    async login(name, onAuthorizationUrl, signal) {
      const pending = login(name, onAuthorizationUrl, signal);
      pendingLogins.add(pending);
      try {
        return await pending;
      } finally {
        pendingLogins.delete(pending);
      }
    },
    close() {
      if (!closing) {
        lifetime.abort();
        closing = Promise.all([
          manager.close(),
          ...[...pendingLogins].map((pending) =>
            pending.then(
              () => undefined,
              () => undefined,
            ),
          ),
        ]).then(() => undefined);
      }
      return closing;
    },
  };
}
