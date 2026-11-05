/** One immutable offered catalog, with calls still owned by the live source manager. */
import type { McpToolSource } from '../tools/mcp/mcp-tool-source.js';
import { createMcpCatalog, MCP_TOOL_BINDING } from '../tools/system/run-code/mcp-script-surface.js';
import { TOOL_NAME_DESCRIBE } from '../tools/system/run-code/script-surface.js';

export type DirectMcpApprovalPolicy = {
  readonly mcpAllowlist: readonly string[];
  isMcpTool(name: string): boolean;
  isMcpAllowed(name: string, allowlist: readonly string[]): boolean;
};
export type DirectMcpRequestScope = {
  /** Pass only to source buildAgent's mcpToolSource, never the provider tool array. */
  readonly source: McpToolSource;
  /** Use the exact final scripted built-in graph for this request, not UI names. */
  approvalPolicy(builtInNames: ReadonlySet<string>): DirectMcpApprovalPolicy;
};

/**
 * Capture once per immutable surface generation. Retain this scope with the
 * matching declaration, execution registry and approval handler until all work
 * admitted by that generation settles. Refresh by replacing the generation,
 * never by changing a sibling request's retained catalog in place.
 */
export function captureDirectMcpSource(
  live: McpToolSource,
  nonInteractiveAllow: readonly string[],
): DirectMcpRequestScope {
  const snapshot = live.snapshot();
  const source: McpToolSource = {
    snapshot: () => snapshot,
    callTool: (server, tool, args, options) => live.callTool(server, tool, args, options),
    // This scope's catalog never changes; subscribe to the manager for live UI.
    onCatalogChanged: () => () => {},
  };
  return {
    source,
    approvalPolicy(builtInNames) {
      // Reuse source sanitization AND collision exclusion. Do not grant by a
      // sanitized name alone: two different raw server/tool pairs can collide.
      const catalog = createMcpCatalog(source, new Set([...builtInNames, TOOL_NAME_DESCRIBE]));
      const bindings = new Map(catalog.tools.map((tool) => [tool.name, tool[MCP_TOOL_BINDING]]));
      return {
        mcpAllowlist: [...nonInteractiveAllow],
        isMcpTool: (name) => bindings.has(name),
        isMcpAllowed(name, allowlist) {
          const binding = bindings.get(name);
          if (!binding) return false;
          return allowlist.some((entry) => {
            const parts = entry.split('/');
            return parts.length === 2 && parts[0] === binding.server && (parts[1] === '*' || parts[1] === binding.tool);
          });
        },
      };
    },
  };
}
