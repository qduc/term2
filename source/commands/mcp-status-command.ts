/**
 * `/mcp` — the only place a user can see their own MCP servers.
 *
 * The model sees the catalog through the `run_code` description; without this
 * the human had no equivalent view, so a server that never came up was
 * indistinguishable from one that was never configured.
 */
import type { SlashCommand } from '../slash-commands.js';
import type { McpConnectionManager } from '../services/mcp/mcp-connection-manager.js';
import { formatMcpStatus } from '../services/mcp/mcp-status.js';

export interface CreateMcpStatusCommandDeps {
  /** Null when this session configured no MCP servers. */
  manager: McpConnectionManager | null;
  /** Named in the empty state so the user learns where to define servers. */
  userConfigPath?: string;
  addSystemMessage: (text: string) => void;
}

export function createMcpStatusCommand({
  manager,
  userConfigPath,
  addSystemMessage,
}: CreateMcpStatusCommandDeps): SlashCommand {
  return {
    name: 'mcp',
    description: 'Show configured MCP servers and their connection state',
    action: () => {
      addSystemMessage(
        formatMcpStatus({
          snapshots: manager?.snapshot() ?? [],
          ...(userConfigPath !== undefined ? { userConfigPath } : {}),
        }),
      );
      return true;
    },
  };
}
