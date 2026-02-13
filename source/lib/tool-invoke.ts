import type { Tool, FunctionTool } from '@openai/agents';

/**
 * Maximum payload size (in characters) for which JSON repair is attempted.
 * Very large payloads are returned as-is to avoid regex backtracking costs.
 */
const MAX_REPAIR_LENGTH = 200_000;

/**
 * Heuristic-based JSON repair for common model-generated errors.
 *
 * Fixes applied (in order):
 * 1. Strip markdown code fences (```json ... ```)
 * 2. Extract JSON object/array from surrounding prose
 * 3. Escape unescaped double-quotes inside JSON string values
 * 4. Remove trailing commas before closing braces/brackets
 *
 * IMPORTANT: Only runs the repair heuristics when `JSON.parse` fails on the
 * input, so already-valid JSON is never modified.
 */
export const repairJson = (text: string): string => {
  if (!text || text.trim() === '') return text;

  // Skip repair for very large payloads to avoid regex backtracking
  if (text.length > MAX_REPAIR_LENGTH) return text;

  // Don't repair already-valid JSON – avoids corrupting valid input
  try {
    JSON.parse(text);
    return text;
  } catch {
    // Fall through to repair logic
  }

  let repaired = text;

  // 1. Strip markdown code fences (```json ... ```)
  repaired = repaired.replace(/^```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '');

  // 2. Extract JSON object/array from surrounding prose
  const jsonMatch = repaired.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    repaired = jsonMatch[1];
  }

  // Check again after stripping – the cleaned text may already be valid
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    // Continue with deeper repairs
  }

  // 3. Fix unescaped double quotes inside values.
  // Logic: find content between : " and "[,}] and escape only the quotes *inside* that content.
  repaired = repaired.replace(/(:\s*")([\s\S]*?)("(?=\s*[,}\]]))/g, (_match, prefix, content, suffix) => {
    // Escape unescaped double quotes (quotes not preceded by a backslash)
    const escapedContent = content.replace(/(?<!\\)"/g, '\\"');
    return prefix + escapedContent + suffix;
  });

  // 4. Fix trailing commas in objects/arrays
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  return repaired;
};

export const normalizeToolInput = (input: unknown): string => {
  if (typeof input === 'string') {
    return repairJson(input);
  }

  try {
    const serialized = JSON.stringify(input);
    return typeof serialized === 'string' ? serialized : '{}';
  } catch {
    return '{}';
  }
};

export const wrapToolInvoke = <T extends Tool>(tool: T): T => {
  // Only FunctionTool has an invoke method
  if (tool.type !== 'function') {
    return tool;
  }

  const functionTool = tool as FunctionTool;
  const originalInvoke = functionTool.invoke.bind(functionTool);
  functionTool.invoke = async (context: any, input: unknown, details: any) => {
    const normalizedInput = normalizeToolInput(input);
    return originalInvoke(context, normalizedInput, details);
  };

  return tool;
};
