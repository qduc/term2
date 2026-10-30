import { formatMcpStatus } from '../services/mcp/mcp-status.js';
export function createMcpStatusCommand({ manager, userConfigPath, addSystemMessage, openMcpMenu, }) {
    return {
        name: 'mcp',
        description: 'Show configured MCP servers and their connection state',
        action: () => {
            if (openMcpMenu) {
                openMcpMenu();
                return true;
            }
            addSystemMessage(formatMcpStatus({
                snapshots: manager?.snapshot() ?? [],
                ...(userConfigPath !== undefined ? { userConfigPath } : {}),
            }));
            return true;
        },
    };
}
//# sourceMappingURL=mcp-status-command.js.map