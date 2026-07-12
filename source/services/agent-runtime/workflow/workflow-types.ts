import type { NormalizedUsage } from '../../../utils/ai/token-usage.js';
import type { RunOutputFormat } from '../types.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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

export function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value as object)) return false;
  ancestors.add(value as object);
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const valid = values.every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value as object);
  return valid;
}
