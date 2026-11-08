/** Audit normalization and provider-facing result items, never execution admission or settlement. */
import type { Item, ItemId } from '../model/index.js';
import type { ExecutionId, ToolResult } from '../tools/contracts.js';

export function toolResultItem(
  executionId: ExecutionId,
  call: Extract<Item, { type: 'tool_call' }>,
  result: ToolResult,
): Item {
  return {
    type: 'tool_result',
    id: `${executionId}:result` as ItemId,
    callId: call.callId,
    output: result.output,
    isError: result.isError,
    ...(result.providerOutput !== undefined ? { providerOutput: result.providerOutput } : {}),
    ...(call.toolType !== undefined ? { toolType: call.toolType } : {}),
  };
}

export function errorResult(error: unknown): ToolResult {
  return { output: error instanceof Error ? error.message : String(error), isError: true };
}

/** Audit normalization never replaces the structured value returned to a script. */
export function childResult(value: unknown): ToolResult {
  if (typeof value === 'object' && value !== null && 'output' in value && typeof value.output === 'string') {
    const result = value as ToolResult;
    return {
      output: result.output,
      isError: result.isError === true,
      ...(result.providerOutput !== undefined ? { providerOutput: result.providerOutput } : {}),
      ...(result.display !== undefined ? { display: result.display } : {}),
    };
  }
  if (typeof value === 'string') return { output: value, isError: false };
  try {
    return { output: JSON.stringify(value) ?? String(value), isError: false };
  } catch {
    return { output: 'Unserializable tool result', isError: false };
  }
}
