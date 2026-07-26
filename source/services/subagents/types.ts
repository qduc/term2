import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { ExecutionBudget } from '../agent-runtime/execution-budget.js';

export const SUBAGENT_ROLES = ['explorer', 'worker', 'researcher', 'mentor', 'librarian'] as const;
export const PHASE_1_ASYNC_SUBAGENT_ROLES = ['explorer', 'researcher', 'mentor'] as const;
export type SupportedSubagentRole = (typeof SUBAGENT_ROLES)[number];
export type Phase1AsyncSubagentRole = (typeof PHASE_1_ASYNC_SUBAGENT_ROLES)[number];
export type SubagentRole = SupportedSubagentRole | string;

export interface SubagentRequest {
  role: SubagentRole;
  task: string;
  /** Parent tool/run cancellation signal. */
  signal?: AbortSignal;
  /** SDK serialized run state for resuming a delegated agent-tool run (nested approvals). */
  resumeState?: string;
  /** Name of the tool that invoked the subagent, if any. */
  parentTool?: string;
  /** Execution-tree budget for tracking aggregate resource usage. */
  executionBudget?: ExecutionBudget;
  /** Continue a completed async session. */
  continueRunId?: string;
}

export interface SubagentDefinition {
  role: SubagentRole;
  name: string;
  instructions: string;
  canRead: boolean;
  canWrite: boolean;
  canSearchWeb: boolean;
  canRunShell: boolean;
  maxTurns: number;
  model: string;
  provider: string;
  reasoningEffort: string;
  /** Maximum tokens cap passed to the provider model settings. */
  maxTokens?: number;
  description?: string;
  /**
   * Optional allowlist of tool names. When set, SubagentToolFactory
   * only provisions tools whose names appear in this list.
   * Undefined/empty = all tools implied by coarse permission flags.
   */
  tools?: string[];
  /**
   * Resolved fine-grained filesystem scopes.
   * Undefined = no restriction (legacy coarse-flag behavior).
   * Defined = scope patterns must be enforced at tool invocation time.
   */
  filesystemScope?: {
    read: string[];
    write: string[];
  };
  /**
   * Resolved fine-grained network host scopes.
   * Undefined = no restriction (legacy coarse-flag behavior).
   * Defined = host patterns must be enforced at tool invocation time.
   */
  networkScope?: string[];
  /**
   * Execution-tree budget for nested agent limits.
   * Undefined = no budget tracking (root-level execution).
   */
  executionBudget?: ExecutionBudget;
  /**
   * Whether this definition represents a root (top-level) execution.
   * Root executions do NOT consume a child slot in the budget;
   * only actual nested agent runs do. Defaults to false.
   */
  isRootExecution?: boolean;
}

export interface SubagentResult {
  agentId: string;
  role: string;
  status: 'completed' | 'failed' | 'cancelled';
  finalText: string;
  filesChanged: string[];
  toolsUsed: Array<{
    toolName: string;
    count: number;
  }>;
  usage?: NormalizedUsage;
  error?: string;
  /** SDK nested run result used to propagate/resume delegated approvals. */
  nestedRunResult?: unknown;
}

/** The only state exposed while an asynchronous run is live. */
export interface SubagentRunHandle {
  runId: string;
  role: string;
  status: 'running';
  task: string;
}

/**
 * Non-blocking progress snapshot of an async run, for the orchestrator's
 * mid-run "what is it doing" query. Never carries completion detail
 * (`finalText` and diff evidence stay on `SubagentResult` / `get_subagent_result`).
 */
export interface SubagentRunStatus {
  runId: string;
  role: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'not_found';
  task: string;
  taskPreview: string;
  startedAt: number;
  elapsedMs: number;
  lastToolName?: string;
  lastToolAt?: number;
  toolCounts: Record<string, number>;
}
