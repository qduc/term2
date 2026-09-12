import { z, type ZodTypeAny } from 'zod';
import { isJsonValue, type JsonValue } from '../services/agent-runtime/workflow/workflow-types.js';
import type { AnyToolDefinition } from './types.js';

/** The two runtime states; prose is intentionally not a third contract state. */
export type ScriptedReturnContract =
  | { readonly kind: 'precise'; readonly schema: ZodTypeAny }
  | { readonly kind: 'unknown' };

export function getScriptedReturnContract(
  tool: Pick<AnyToolDefinition, 'scriptedReturnSchema'>,
): ScriptedReturnContract {
  return tool.scriptedReturnSchema ? { kind: 'precise', schema: tool.scriptedReturnSchema } : { kind: 'unknown' };
}

/** Convert the owner schema for discovery and the future declaration generator. */
export function scriptedReturnContractJsonSchema(contract: ScriptedReturnContract): JsonValue {
  if (contract.kind === 'unknown') return { kind: 'unknown' };
  try {
    return { kind: 'precise', schema: z.toJSONSchema(contract.schema, { io: 'output' }) as JsonValue };
  } catch {
    // A schema can still validate at runtime when a provider-oriented JSON
    // projection cannot represent it. Discovery must not invent a type.
    return { kind: 'precise', schema: { unconvertible: true } };
  }
}

export interface ScriptedReturnValidation {
  readonly ok: true;
  readonly value: JsonValue;
}

export interface ScriptedReturnValidationFailure {
  readonly ok: false;
  readonly message: string;
}

/** Validate the post-normalization value, before it is sent through the VM. */
export function validateScriptedReturn(
  tool: Pick<AnyToolDefinition, 'scriptedReturnSchema'>,
  value: unknown,
): ScriptedReturnValidation | ScriptedReturnValidationFailure {
  const contract = getScriptedReturnContract(tool);
  if (contract.kind === 'unknown') return { ok: true, value: value as JsonValue };

  const parsed = contract.schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, message: issues || 'value did not match the declared schema' };
  }
  if (!isJsonValue(parsed.data)) return { ok: false, message: 'validated value was not JSON-safe' };
  return { ok: true, value: parsed.data };
}
