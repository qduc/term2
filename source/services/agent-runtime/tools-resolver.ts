import type { ResolvedAgentPermissions } from './types.js';

/**
 * Known tool name → required permission mapping.
 * Only tools that exist in the Term2 tool set are listed here.
 * Adding a tool here makes it available for agent-runtime resolution;
 * tools not listed are treated as unknown and produce validation failures.
 */
const TOOL_PERMISSION_MAP: Record<string, keyof ResolvedAgentPermissions> = {
  read_file: 'canRead',
  grep: 'canRead',
  glob: 'canRead',
  read_code_outline: 'canRead',
  code_context_search: 'canRead',
  web_search: 'canSearchWeb',
  web_fetch: 'canSearchWeb',
  apply_patch: 'canWrite',
  search_replace: 'canWrite',
  create_file: 'canWrite',
  shell: 'canRunShell',
  ask_user: 'canRead', // always available; permission acts as read-only gate
  ask_mentor: 'canUseNestedAgents',
  run_subagent: 'canUseNestedAgents',
  activate_skill: 'canRead',
};

export interface ToolResolutionResult {
  /** Resolved tool names that pass authority checks. */
  resolved: string[];
  /** Errors for unknown tools or tools the parent does not authorize. */
  errors: Array<{ code: string; toolName: string; message: string }>;
}

/**
 * Validate requested tool names against the known tool set and intersect
 * with the effective permissions computed earlier by the resolver.
 *
 * Resolution pipeline:
 * 1. If `requested` is undefined or empty → no tools resolved.
 * 2. If `authorized` (permissions.tools) is defined, reject any requested
 *    tool not present in the authorization list with `permission_denied`.
 * 3. Unknown tool names produce `unknown_tool` validation failures.
 * 4. Known tools whose required coarse permission is denied by the
 *    effective authority produce `permission_denied` failures.
 * 5. Remaining tools are returned as the resolved set.
 */
export function resolveTools(
  requested: ReadonlyArray<string> | undefined,
  effectivePermissions: ResolvedAgentPermissions,
  authorized?: ReadonlyArray<string>,
): ToolResolutionResult {
  if (!requested || requested.length === 0) {
    return { resolved: [], errors: [] };
  }

  const authorizedSet = authorized ? new Set(authorized) : undefined;
  const resolved: string[] = [];
  const errors: ToolResolutionResult['errors'] = [];

  for (const toolName of requested) {
    // ── Authorization gate (permissions.tools) ──
    if (authorizedSet !== undefined && !authorizedSet.has(toolName)) {
      errors.push({
        code: 'permission_denied',
        toolName,
        message: `Tool "${toolName}" is not authorized by the effective permissions.`,
      });
      continue;
    }

    // ── Known-tool check ──
    const requiredPermission = TOOL_PERMISSION_MAP[toolName];
    if (requiredPermission === undefined) {
      errors.push({
        code: 'unknown_tool',
        toolName,
        message: `Unknown tool: "${toolName}". Check the available tool set.`,
      });
      continue;
    }

    // ── Coarse permission gate ──
    if (effectivePermissions[requiredPermission] !== true) {
      errors.push({
        code: 'permission_denied',
        toolName,
        message: `Tool "${toolName}" requires permission "${requiredPermission}" which is not granted.`,
      });
      continue;
    }

    resolved.push(toolName);
  }

  return { resolved, errors };
}
