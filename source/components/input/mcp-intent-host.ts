import type { McpConfigController } from '../../services/mcp/mcp-config-controller.js';
import type { McpConnectionManager } from '../../services/mcp/mcp-connection-manager.js';
import type { IntentRequest, IntentResult } from './menu-types.js';

export type McpIntentHostDeps = {
  manager: McpConnectionManager;
  configController: McpConfigController;
  login?: (name: string) => void | Promise<void>;
};

export async function handleMcpIntent(
  request: IntentRequest,
  deps: McpIntentHostDeps,
): Promise<IntentResult | undefined> {
  const { id, sourceFrameId, intent } = request;
  try {
    switch (intent.type) {
      case 'mcp-reconnect':
        await deps.manager.reconnect(intent.serverName);
        break;
      case 'mcp-login':
        await deps.login?.(intent.serverName);
        break;
      case 'mcp-save':
        await deps.configController.saveUserServer(intent.originalName, intent.name, intent.config);
        break;
      case 'mcp-delete':
        await deps.configController.deleteUserServer(intent.serverName);
        break;
      default:
        return undefined;
    }
    return { id, sourceFrameId, ok: true };
  } catch (error) {
    return {
      id,
      sourceFrameId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
