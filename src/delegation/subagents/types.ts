import type { ExecutionBudget } from '../../session/agent-runtime/execution-budget.js';

import type { AgentSpec } from '../../session/agent-runtime/types.js';

import type { SubagentRole } from '../../tools/subagents/types.js';

// Tool-facing results and control acknowledgements remain contracts below the
// execution layer. Requests resolved for execution carry private runtime policy.
export type * from '../../tools/subagents/types.js';

export interface SubagentRequest {
  role: SubagentRole;
  task: string;
  agentSpec?: AgentSpec;
  resolvedDefinition?: SubagentDefinition;
  name?: string;
  signal?: AbortSignal;
  resumeState?: string;
  parentTool?: string;
  executionBudget?: ExecutionBudget;
  continueRunId?: string;
  worktree?: string;
  authorizedWorktreePath?: string;
}

/** Host-resolved role, capabilities and execution-tree authority for one run. */
export interface SubagentDefinition {
  role: SubagentRole;
  name: string;
  instructions: string;
  /**
   * `role-file` only when `instructions` is a Term2 role file's body (`loadRoleDefinition`).
   * Prompt assembly deletes audience-dead text only from Term2-authored text, so any other
   * definition's instructions (a parent's agent_spec) are sent exactly as written.
   */
  instructionsSource?: 'role-file';
  canRead: boolean;
  canWrite: boolean;
  canSearchWeb: boolean;
  canRunShell: boolean;
  maxTurns: number;
  model: string;
  provider: string;
  reasoningEffort: string;
  maxTokens?: number;
  description?: string;
  tools?: string[];
  isScriptGeneric?: boolean;
  filesystemScope?: { read: string[]; write: string[] };
  networkScope?: string[];
  executionBudget?: ExecutionBudget;
  isRootExecution?: boolean;
}
