import type { ISettingsService } from '../service-interfaces.js';
import type { ResolvedAgentDefinition } from './resolved-agent.js';
import type { SubagentDefinition, SupportedSubagentRole } from '../subagents/types.js';
import { loadRoleDefinition } from '../subagents/role-loader.js';
import type { ExecutionBudget } from './execution-budget.js';

/**
 * Adapt a legacy subagent role into a ResolvedAgentDefinition.
 * This preserves existing role behavior by loading the trusted host preset
 * and converting to the new internal shape.
 */
export function adaptLegacyRole(
  role: SupportedSubagentRole | string,
  settings: ISettingsService,
): ResolvedAgentDefinition {
  const def: SubagentDefinition = loadRoleDefinition(role, settings);

  return {
    name: def.name,
    instructions: def.instructions,
    model: { provider: def.provider, model: def.model },
    permissions: {
      canRead: def.canRead,
      canWrite: def.canWrite,
      canRunShell: def.canRunShell,
      canSearchWeb: def.canSearchWeb,
      canUseNestedAgents: false,
    },
    limits: {
      maxTurns: def.maxTurns,
    },
    tools: [],
    skillInstructions: '',
    // Legacy roles have undefined scopes (no fine-grained restriction —
    // they continue to use their existing coarse behavior).
    filesystemScope: undefined,
    networkScope: undefined,
    resolutionErrors: [],
  };
}

/**
 * Convert a ResolvedAgentDefinition back to the legacy SubagentDefinition
 * shape. Used when the new runtime creates an agent that must execute through
 * the existing SubagentManager / ExecutionSubagentRunner infrastructure.
 */
export function adaptLegacyDefinition(resolved: ResolvedAgentDefinition, budget?: ExecutionBudget): SubagentDefinition {
  return {
    role: resolved.name,
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
    ...(resolved.limits.maxTokens !== undefined ? { maxTokens: resolved.limits.maxTokens } : {}),
    ...(resolved.tools.length > 0 ? { tools: [...resolved.tools] } : {}),
    ...(resolved.filesystemScope ? { filesystemScope: resolved.filesystemScope } : {}),
    ...(resolved.networkScope ? { networkScope: resolved.networkScope } : {}),
    ...(budget ? { executionBudget: budget } : {}),
  };
}

/** Re-export SubagentDefinition type for convenience. */
export type { SubagentDefinition } from '../subagents/types.js';
