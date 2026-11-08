import type { ResolvedAgentDefinition } from '../../session/agent-runtime/resolved-agent.js';
import type { SubagentDefinition } from '../subagents/types.js';

import type { ExecutionBudget } from '../../session/agent-runtime/execution-budget.js';

/**
 * Convert a ResolvedAgentDefinition back to the SubagentDefinition shape that
 * the role and tool-policy helpers in `delegation/subagents/` still read. The
 * direct launcher (`delegation/direct/subagent-tools.ts`) is the only caller.
 */
export function adaptLegacyDefinition(resolved: ResolvedAgentDefinition, budget?: ExecutionBudget): SubagentDefinition {
  return {
    role: resolved.legacyRole ?? resolved.name,
    name: resolved.name,
    instructions: resolved.instructions,
    canRead: resolved.permissions.canRead ?? false,
    canWrite: resolved.permissions.canWrite ?? false,
    canSearchWeb: resolved.permissions.canSearchWeb ?? false,
    canRunShell: resolved.permissions.canRunShell ?? false,
    maxTurns: resolved.limits.maxTurns ?? 20,
    model: resolved.model.model,
    provider: resolved.model.provider,
    reasoningEffort: 'default',
    ...(resolved.responseMaxTokens !== undefined
      ? { maxTokens: resolved.responseMaxTokens }
      : resolved.limits.maxTokens !== undefined
      ? { maxTokens: resolved.limits.maxTokens }
      : {}),
    ...(resolved.tools.length > 0 ? { tools: [...resolved.tools] } : {}),
    ...(resolved.filesystemScope ? { filesystemScope: resolved.filesystemScope } : {}),
    ...(resolved.networkScope ? { networkScope: resolved.networkScope } : {}),
    ...(budget ? { executionBudget: budget } : {}),
  };
}

/** Re-export SubagentDefinition type for convenience. */
export type { SubagentDefinition } from '../subagents/types.js';
