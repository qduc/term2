/** Daemon-owned MCP connections for admitted local workspaces. */
import fs from 'node:fs';
import { DirectProtocolError } from '../../protocol/errors.js';
import { openInBrowser } from '../../shared/lib/oauth-loopback.js';
import type { Workspace } from '../../tools/index.js';
import type { McpServerSnapshot } from '../../tools/mcp/mcp-tool-source.js';
import { createDirectMcpCredentialStore, createDirectMcpRefresh } from '../application-mcp.js';
import type { DirectRuntimeOptions } from '../application-runtime.js';
import { createDirectMcp, createDirectMcpOAuth } from '../mcp.js';

function serverStatus({ name, state, tools }: McpServerSnapshot) {
  return { name, state, toolCount: tools.length };
}

export function createDaemonMcp(options: {
  readonly conversationsDir: string;
  readonly settingsDir: string | undefined;
  readonly onWarning: (message: string) => void;
}) {
  const { conversationsDir, settingsDir, onWarning } = options;
  const oauth = createDirectMcpOAuth({
    store: createDirectMcpCredentialStore(conversationsDir),
    openBrowser: openInBrowser,
  });

  const open = async (workspace: Workspace) => {
    const mcp = await createDirectMcp({
      workspace,
      ...(settingsDir ? { settingsDir } : {}),
      // Browser authority belongs to the daemon's local owner. Individual
      // sessions still apply their own interactive/tool approval mode.
      interactive: true,
      oauth,
      onNotice: onWarning,
    });
    const refresh = createDirectMcpRefresh(mcp, onWarning);
    try {
      mcp.start();
      return { mcp, refresh };
    } catch (error) {
      refresh.close();
      await mcp.close();
      throw error;
    }
  };

  const workspaces = new Map<string, ReturnType<typeof open>>();
  let closing: Promise<void> | undefined;
  const getOrOpen = (workspace: Workspace) => {
    if (closing) throw new DirectProtocolError('closed', 'Daemon MCP is closing.');
    const existing = workspaces.get(workspace.root);
    if (existing) return existing;
    const pending = open(workspace).catch((error: unknown) => {
      workspaces.delete(workspace.root);
      onWarning(`MCP startup failed: ${String(error)}`);
      throw new DirectProtocolError('unavailable', 'MCP startup failed.');
    });
    workspaces.set(workspace.root, pending);
    return pending;
  };

  return {
    async prepare(
      sessionId: string,
      workspace: Workspace,
      interactive: boolean,
    ): ReturnType<NonNullable<DirectRuntimeOptions['prepareSurface']>> {
      if (workspace.target !== 'local') return {};
      try {
        // Stored identities can name a path that has since disappeared or
        // become a symlink. Only a current canonical directory may load config.
        if (fs.realpathSync(workspace.root) !== workspace.root || !fs.statSync(workspace.root).isDirectory()) {
          return {};
        }
      } catch {
        return {};
      }
      const { mcp, refresh } = await getOrOpen(workspace);
      if (!interactive) {
        await mcp.whenSettled();
        return { surface: { mcp } };
      }
      const epoch = refresh.epoch;
      return {
        surface: { mcp },
        trackMcpCatalog: (session) => refresh.track(session, epoch),
        dispose: async () => refresh.untrack(sessionId),
      };
    },
    singleActiveRoot(): string | undefined {
      if (workspaces.size > 1) {
        throw new DirectProtocolError(
          'invalid_command',
          'Specify an MCP workspace when multiple workspaces are active.',
        );
      }
      return workspaces.keys().next().value;
    },
    async status(root: string | undefined) {
      const active = root ? await workspaces.get(root) : undefined;
      return { servers: active ? active.mcp.snapshot().map(serverStatus) : [] };
    },
    async login(root: string | undefined, serverId: string) {
      const active = root ? await workspaces.get(root) : undefined;
      if (!active || !active.mcp.snapshot().some(({ name }) => name === serverId)) {
        throw new DirectProtocolError('not_found', 'Unknown MCP server in this workspace.');
      }
      try {
        await active.mcp.whenSettled();
        const server = await active.mcp.login(serverId);
        return { server: serverStatus(server) };
      } catch (error) {
        onWarning(`MCP login failed: ${String(error)}`);
        throw new DirectProtocolError('unavailable', 'MCP login could not complete. See the daemon log.');
      }
    },
    close() {
      closing ??= Promise.allSettled(workspaces.values()).then(async (opened) => {
        workspaces.clear();
        await Promise.all(
          opened.map(async (entry) => {
            if (entry.status !== 'fulfilled') return;
            entry.value.refresh.close();
            await entry.value.mcp.close();
          }),
        );
      });
      return closing;
    },
  };
}
