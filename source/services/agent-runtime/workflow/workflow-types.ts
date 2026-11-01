import type { NormalizedUsage } from '../../../utils/ai/token-usage.js';
import type { RunOutputFormat } from '../types.js';

import type { JsonValue } from '../../../utils/json-value.js';

// Preserve the workflow API while the transport contract lives below its consumers.
export { isJsonValue, type JsonValue } from '../../../utils/json-value.js';

export interface WorkflowAgentConfig {
  name?: string;
  instructions: string;
  model?: 'lower' | 'default' | 'higher';
  tools?: string[];
}

export interface WorkflowRunInput {
  task: string;
  /** JSON-safe object transport; AgentHandle validates/injects its semantic form. */
  context?: { [key: string]: JsonValue };
  /** JSON-safe transport for AgentHandle's structured-output contract. */
  output?: RunOutputFormat;
}
export type WorkflowRunResult =
  | { ok: true; output: JsonValue; usage?: NormalizedUsage }
  | { ok: false; error: { code: string; message: string }; usage?: NormalizedUsage };

export interface WorkflowInput {
  code: string;
  signal?: AbortSignal;
}
export interface WorkflowRunSummary {
  /** Stable, one-based order in which this run was admitted. */
  runId: number;
  /** Name supplied to agent(config), before runtime resolution. */
  requestedName?: string;
  name?: string;
  provider?: string;
  model?: string;
  ok: boolean;
  durationMs: number;
  usage?: NormalizedUsage;
  errorCode?: string;
}
export interface WorkflowError {
  code:
    | 'syntax_error'
    | 'runtime_error'
    | 'timeout'
    | 'deadline'
    | 'cancelled'
    | 'limit_exceeded'
    | 'approval_required'
    | 'sandbox_unavailable'
    | 'invalid_output'
    | 'code_too_large';
  message: string;
}
export type WorkflowResult =
  | { ok: true; output: JsonValue; runs: WorkflowRunSummary[] }
  | { ok: false; error: WorkflowError; runs: WorkflowRunSummary[] };

export interface WorkflowLimits {
  timeoutMs: number;
  maxRuns: number;
  maxConcurrency: number;
  maxCodeBytes: number;
  maxOutputBytes: number;
  maxConsoleBytes: number;
}
export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  timeoutMs: 120_000,
  maxRuns: 8,
  maxConcurrency: 3,
  maxCodeBytes: 16_384,
  maxOutputBytes: 65_536,
  maxConsoleBytes: 16_384,
};

export interface WorkflowEvaluator {
  evaluate(input: WorkflowInput): Promise<WorkflowResult>;
}
