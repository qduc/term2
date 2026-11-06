import type { JsonValue } from '../../../shared/utils/json-value.js';
import type { ToolRegistry } from '../../types.js';
import type { RunCodeExecution } from './run-code-execution.js';

/** Execute one script against the final wrapped graph, preserving typed evidence. */
export interface RunCodeRuntimePort {
  discovery(): ToolRegistry;
  execute(input: RunCodeRuntimeInput): Promise<RunCodeRuntimeResult>;
}

export interface RunCodeRuntimeInput {
  code: string;
  inputs: Record<string, JsonValue>;
  timeout: number;
  description: string;
  context?: unknown;
  signal?: AbortSignal;
}

export interface RunCodeRuntimeResult {
  execution: RunCodeExecution;
  output: readonly string[];
}

/** Late-bound graph authority, not a registry reconstructed by the tool leaf. */
export interface RunCodeRuntimeGraph {
  registry: ToolRegistry;
  directToolNames: readonly string[];
  graphIdentity: object;
}
