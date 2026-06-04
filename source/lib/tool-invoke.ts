import type { Tool, FunctionTool } from '@openai/agents';
import { z } from 'zod';

/**
 * Maximum payload size (in characters) for which JSON repair is attempted.
 * Very large payloads are returned as-is to avoid regex backtracking costs.
 */
const MAX_REPAIR_LENGTH = 200_000;

const escapeRawControlCharactersInStrings = (text: string): string => {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      result += char;
      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = false;
      result += char;
      continue;
    }

    if (char === '\r') {
      if (text[index + 1] === '\n') {
        index++;
      }
      result += '\\n';
      continue;
    }

    if (char === '\n') {
      result += '\\n';
      continue;
    }

    if (char === '\t') {
      result += '\\t';
      continue;
    }

    const charCode = char.charCodeAt(0);
    if (charCode < 0x20) {
      result += `\\u${charCode.toString(16).padStart(4, '0')}`;
      continue;
    }

    result += char;
  }

  return result;
};

/**
 * Heuristic-based JSON repair for common model-generated errors.
 *
 * Fixes applied (in order):
 * 1. Strip markdown code fences (```json ... ```)
 * 2. Extract JSON object/array from surrounding prose
 * 3. Escape raw control characters inside JSON string values
 * 4. Escape unescaped double-quotes inside JSON string values
 * 5. Remove trailing commas before closing braces/brackets
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

  // 3. Fix raw control characters inside string values. This commonly
  // happens when models emit multiline tool arguments like apply_patch diffs
  // with literal newlines instead of JSON-escaped \n sequences.
  repaired = escapeRawControlCharactersInStrings(repaired);

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    // Continue with deeper repairs
  }

  // 4. Fix unescaped double quotes inside values.
  // Logic: find content between : " and "[,}] and escape only the quotes *inside* that content.
  repaired = repaired.replace(/(:\s*")([\s\S]*?)("(?=\s*[,}\]]))/g, (_match, prefix, content, suffix) => {
    // Escape unescaped double quotes (quotes not preceded by a backslash)
    const escapedContent = content.replace(/(?<!\\)"/g, '\\"');
    return prefix + escapedContent + suffix;
  });

  repaired = escapeRawControlCharactersInStrings(repaired);

  // 5. Fix trailing commas in objects/arrays
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  return repaired;
};

function getZodSchema(schema: any): any {
  if (!schema) return null;
  if (schema.safeParse && typeof schema.safeParse === 'function') {
    return schema;
  }
  if (schema.schema && typeof schema.schema.safeParse === 'function') {
    return schema.schema;
  }
  return null;
}

function getObjectShape(schema: any): Record<string, any> | null {
  const zodSchema = getZodSchema(schema);
  if (!zodSchema) return null;
  if (zodSchema instanceof z.ZodObject || zodSchema.shape) {
    return zodSchema.shape;
  }
  if (zodSchema._def && zodSchema._def.schema) {
    return getObjectShape(zodSchema._def.schema);
  }
  return null;
}

function unwrapSchema(schema: any): any {
  let current = schema;
  while (current) {
    const def = current.def || current._def;
    if (!def) break;
    const typeName = def.type || def.typeName;
    const isOptional = typeName === 'optional' || typeName === 'ZodOptional';
    const isNullable = typeName === 'nullable' || typeName === 'ZodNullable';
    if (isOptional || isNullable) {
      if (typeof current.unwrap === 'function') {
        current = current.unwrap();
      } else {
        current = def.innerType;
      }
    } else if (typeName === 'default' || typeName === 'ZodDefault') {
      current = def.innerType;
    } else if (typeName === 'effects' || typeName === 'ZodEffects') {
      current = def.schema;
    } else {
      break;
    }
  }
  return current;
}

/**
 * Normalize a plain-object params bag in-place according to the Zod schema.
 *
 * Applies the same coercions as {@link normalizeToolInput} but operates directly
 * on a JS object, avoiding a JSON round-trip. Returns the same reference when
 * no modifications are needed, or a shallow clone with the normalised values.
 *
 * Skips non-object / null inputs and returns them unchanged.
 */
export const normalizeObjectParams = (params: unknown, schema?: z.ZodTypeAny): unknown => {
  if (params === null || params === undefined) return params;
  if (typeof params !== 'object' || Array.isArray(params)) return params;
  if (!schema) return params;

  const shape = getObjectShape(schema);
  if (!shape) return params;

  let modified = false;
  const result = { ...(params as Record<string, unknown>) };

  for (const key of Object.keys(shape)) {
    const fieldSchema = shape[key];
    if (!fieldSchema || typeof fieldSchema.safeParse !== 'function') continue;

    const value = result[key];
    if (value === undefined) continue;

    // 1. Optional field sentinels: "null", "None", "" or null -> undefined (omit)
    if (fieldSchema.safeParse(undefined).success) {
      if (value === 'null' || value === 'None' || value === '' || value === null) {
        delete result[key];
        modified = true;
        continue;
      }
    }

    // 2. Boolean coercion: "true"/"false" -> boolean
    const isBool =
      fieldSchema.safeParse(true).success &&
      fieldSchema.safeParse(false).success &&
      !fieldSchema.safeParse('not a boolean').success;
    if (isBool && typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true') {
        result[key] = true;
        modified = true;
      } else if (lower === 'false') {
        result[key] = false;
        modified = true;
      }
    }

    // 3. Array or Object coercion from stringified representation
    const unwrapped = unwrapSchema(fieldSchema);
    if (typeof value === 'string' && unwrapped) {
      const def = unwrapped.def || unwrapped._def;
      if (def) {
        const typeName = def.type || def.typeName;
        const trimmed = value.trim();
        if ((typeName === 'array' || typeName === 'ZodArray') && trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsedArray = JSON.parse(trimmed);
            if (Array.isArray(parsedArray)) {
              result[key] = parsedArray;
              modified = true;
            }
          } catch {
            // Ignore parsing error
          }
        } else if (
          (typeName === 'object' || typeName === 'ZodObject') &&
          trimmed.startsWith('{') &&
          trimmed.endsWith('}')
        ) {
          try {
            const parsedObj = JSON.parse(trimmed);
            if (parsedObj && typeof parsedObj === 'object' && !Array.isArray(parsedObj)) {
              result[key] = parsedObj;
              modified = true;
            }
          } catch {
            // Ignore parsing error
          }
        }
      }
    }
  }

  return modified ? result : params;
};

export const normalizeToolInput = (input: unknown, schema?: z.ZodTypeAny): string => {
  let jsonStr = '';
  if (typeof input === 'string') {
    jsonStr = repairJson(input);
  } else {
    try {
      jsonStr = JSON.stringify(input);
      if (typeof jsonStr !== 'string') {
        jsonStr = '{}';
      }
    } catch {
      jsonStr = '{}';
    }
  }

  if (schema) {
    try {
      const parsed = JSON.parse(jsonStr);
      const normalized = normalizeObjectParams(parsed, schema);
      if (normalized !== parsed) {
        jsonStr = JSON.stringify(normalized);
      }
    } catch {
      // Ignore parsing errors and return jsonStr as-is
    }
  }

  return jsonStr;
};

/**
 * Detects the SDK's schema-validation error (thrown by `tool()` when the
 * incoming arguments fail to parse) across SDK versions / bundlers that may
 * rename the class.
 */
export const isInvalidToolInputError = (error: any): boolean => {
  if (!error) return false;
  const name = error.name || error.constructor?.name;
  return name === 'InvalidToolInputError' || name === 'AI_InvalidToolInputError';
};

/**
 * Custom `errorFunction` for SDK `tool()` definitions.
 *
 * The SDK's default error handler swallows *every* thrown error into a result
 * string, which forces brittle string-scanning to tell schema-validation
 * failures apart from a tool that merely prints those words. Instead, we let
 * schema-validation errors propagate so `wrapToolInvoke` can attach precise Zod
 * diagnostics, while keeping all other runtime errors as non-fatal strings
 * (mirroring the SDK's default behavior) so the runner stays stable.
 */
export const toolErrorFunction = (_context: unknown, error: unknown): string => {
  if (isInvalidToolInputError(error)) {
    throw error;
  }
  const details = error instanceof Error ? error.toString() : String(error);
  return `An error occurred while running the tool. Please try again. Error: ${details}`;
};

export const wrapToolInvoke = <T extends Tool>(tool: T, originalSchema?: z.ZodTypeAny): T => {
  // Only FunctionTool has an invoke method
  if (tool.type !== 'function') {
    return tool;
  }

  const functionTool = tool as FunctionTool;
  const originalInvoke = functionTool.invoke.bind(functionTool);
  functionTool.invoke = async (context: any, input: unknown, details: any) => {
    const targetSchema = originalSchema || functionTool.parameters;
    const normalizedInput = normalizeToolInput(input, targetSchema as any);

    const runDiagnostics = (toolName: string, schema: z.ZodTypeAny, rawInput: any): string => {
      let parsedInput: any;
      try {
        parsedInput = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      } catch {
        parsedInput = rawInput;
      }

      const zodSchema = getZodSchema(schema);
      if (zodSchema) {
        const parseResult = zodSchema.safeParse(parsedInput);
        if (!parseResult.success) {
          const issues = parseResult.error.issues.map((issue: any) => {
            const field = issue.path.join('.') || 'input';
            let actualVal = parsedInput;
            for (const segment of issue.path) {
              if (actualVal && typeof actualVal === 'object') {
                actualVal = (actualVal as any)[segment];
              }
            }
            const valStr = typeof actualVal === 'string' ? `"${actualVal}"` : JSON.stringify(actualVal);
            const typeStr = actualVal === null ? 'null' : typeof actualVal;

            let msg = issue.message;
            if (issue.code === 'invalid_type') {
              msg = `must be ${issue.expected}`;
            }
            return `${field} ${msg}, got ${typeStr} ${valStr}`;
          });
          return `Tool input did not match schema for ${toolName}: ${issues.join(
            '; ',
          )}. Retry with valid JSON arguments.`;
        }
      }
      return `Tool input was invalid for this tool. Retry with arguments matching the tool schema.`;
    };

    try {
      return await originalInvoke(context, normalizedInput, details);
    } catch (error: any) {
      if (isInvalidToolInputError(error)) {
        // Surface schema diagnostics as a non-fatal tool result so the model
        // can self-correct within the same turn, rather than aborting the run.
        return runDiagnostics(functionTool.name, targetSchema as any, normalizedInput);
      }
      throw error;
    }
  };

  return tool;
};
