// Internal exports for testing, legacy adaptation, and subagent integration.
// Do NOT import from this file in application code outside of tests,
// legacy adapters, or the subagent composition layer.

export { resolveModelPolicy } from './model-resolver.js';
export {
  resolvePermissions,
  resolveLimits,
  DEFAULT_RESOLVED_PERMISSIONS,
  DEFAULT_LIMITS,
  type PermissionResolutionError,
} from './permission-resolver.js';
export { resolveSkills } from './skill-resolver.js';
export { resolveAgent } from './agent-resolver.js';
export { resolveTools } from './tools-resolver.js';
export type { ResolvedAgentDefinition } from './resolved-agent.js';
export type { ResolvedAgentPermissions } from './types.js';
export type { ExecutorInput, ExecutorFn } from './agent-handle.js';
export { createExecutor, mapSubagentResultToRunResult } from './executor.js';
export type { SubagentRunWithDefFn, MentorRunFn } from './executor.js';
export { adaptLegacyRole, adaptLegacyDefinition } from './legacy-adapter.js';
export type { AgentResolverDeps } from './agent-resolver.js';
export {
  normalizeToolPath,
  resolveRealToolPath,
  isPathInScopeSafe,
  normalizeScopePattern,
  normalizeHostPattern,
  isPathInScope,
  isHostInScope,
  resolveFilesystemScopes,
  resolveNetworkScopes,
  isFilesystemScopeEmpty,
  isNetworkScopeEmpty,
  setWorkspaceRoot,
  type ResolvedFilesystemScope,
  type ResolvedNetworkScope,
  type ScopeResolutionError,
} from './scope-resolver.js';
export {
  ExecutionBudget,
  createRootBudget,
  AcquiredChildSlot,
  type ChildAcquireRejection,
} from './execution-budget.js';
