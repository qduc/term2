// Public API – stable contract surface for consumers of AgentRuntime.
// Supports one-shot agent execution with text attachments, structured
// JSON output, context injection, cancellation/timeout signals, and
// skill instruction resolution.

export { AgentRuntime, type AgentRuntimeDeps } from './agent-runtime.js';
export {
  // Types
  type AgentConfig,
  type AgentHandle,
  type RunInput,
  type RunResult,
  type RunError,
  type RunErrorCode,
  type RunAttachment,
  type RunOutputFormat,
  type ArtifactReference,
  type ModelPolicy,
  type ModelTier,
  type RelativeModelPolicy,
  type ExactModelPolicy,
  type AgentPermissions,
  type AgentLimits,
  type ToolReference,
} from './types.js';

// Resolved scope types (used by adapters and executors)
export type { ResolvedFilesystemScope, ResolvedNetworkScope } from './scope-resolver.js';

// Production composition – backed by real subagent infrastructure
// (ExecutionSubagentRunner / MentorRunner) with shared tool policies.
export {
  createAgentRuntime,
  createAgentRuntimeFromSubagentRuntime,
  type CreateAgentRuntimeDeps,
  type AgentRuntimeComposition,
  type AgentRuntimeFromSubagentRuntimeDeps,
} from './compose-agent-runtime.js';

// Execution budget for tree-level resource enforcement
export { ExecutionBudget, createRootBudget, type ChildAcquireRejection } from './execution-budget.js';

// ── Internal types re-exported for subagent integration ───────────────
// These are used by SubagentManager / NestedSubagentRunner to bridge
// legacy roles through the shared resolver. They are NOT part of the
// public consumer API.
export type { ResolvedAgentDefinition } from './resolved-agent.js';
export type { ResolvedAgentPermissions } from './types.js';
