// Public API – stable contract surface for consumers of AgentRuntime.
// Supports one-shot agent execution with text attachments, structured
// JSON output, context injection, cancellation/timeout signals, and
// skill instruction resolution.

export type { AgentRuntime, AgentRuntimeDeps } from './agent-runtime.js';
export {
  // Types
  type AgentConfig,
  type AgentSpec,
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
export {
  agentSpecToConfig,
  AGENT_SPEC_TOOL_NAMES,
  DEFAULT_AGENT_SPEC_TOOLS,
  AGENT_SPEC_DEFAULT_MAX_TURNS,
} from './agent-spec.js';

export {
  createRootAgentAuthoritySnapshot,
  parentAuthorityFromDefinition,
  resolveAgentSpecForChild,
  type AgentSpecAuthoritySnapshot,
  type AgentPermissionBoundaryParent,
  type AgentSpecBoundaryError,
  type AgentSpecBoundaryErrorCode,
  type AgentSpecBoundaryResult,
  type ResolveAgentSpecForChildOptions,
} from './permission-boundary.js';

// Bounded programmable workflow evaluator types.
export type {
  JsonValue,
  WorkflowAgentConfig,
  WorkflowEvaluator,
  WorkflowInput,
  WorkflowLimits,
  WorkflowResult,
  WorkflowRunInput,
  WorkflowRunResult,
  WorkflowRunSummary,
} from './workflow/workflow-types.js';

// ── Internal types re-exported for subagent integration ───────────────
// These are used by SubagentManager / NestedSubagentRunner to bridge
// legacy roles through the shared resolver. They are NOT part of the
// public consumer API.
export type { ResolvedAgentDefinition } from './resolved-agent.js';
export type { ResolvedAgentPermissions } from './types.js';
