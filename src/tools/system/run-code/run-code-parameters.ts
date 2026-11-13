import { z } from 'zod';
import { relaxedNumber } from '../../utils.js';
import type { JsonValue } from '../../sandboxed-code-host/host-types.js';

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Node `setTimeout` wraps delays above `2**31-1` to ~1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

const encodeInputKeysForValidation = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(encodeInputKeysForValidation);
  if (value === null || typeof value !== 'object') return value;
  const encoded = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(encoded, `$${key}`, {
      value: encodeInputKeysForValidation(item),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return encoded;
};

const decodeValidatedInputKeys = (value: Record<string, JsonValue>): Record<string, JsonValue> => {
  const decode = (item: JsonValue): JsonValue => {
    if (Array.isArray(item)) return item.map(decode);
    if (item === null || typeof item !== 'object') return item;
    const decoded = Object.create(null) as Record<string, JsonValue>;
    for (const [key, nested] of Object.entries(item)) {
      Object.defineProperty(decoded, key.slice(1), {
        value: decode(nested),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return decoded;
  };
  return decode(value) as Record<string, JsonValue>;
};

// The shared code-plus-inputs admission limit is stated once, in the tool description.
const RUN_CODE_INPUTS_DESCRIPTION =
  'JSON data exposed to the script as the global `inputs`. Use this for patch or file text.';

const runCodeInputsSchema = z
  .preprocess(encodeInputKeysForValidation, z.record(z.string(), z.json()))
  // Zod records omit `__proto__`; prefixing every key before validation and
  // removing exactly one prefix afterward keeps all JSON object keys inert.
  .overwrite(decodeValidatedInputKeys);

/**
 * Script-shaped limits. They are deliberately not the workflow's: a workflow
 * spawns a handful of agents, while a script's whole point is looping over many
 * cheap tool calls.
 */

export const runCodeParametersSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'JavaScript (not TypeScript) executed as the body of an async function. Top-level await is available. ' +
        'Return the value you want the model to receive. Use console.log only for debugging.',
    ),
  inputs: runCodeInputsSchema.optional().describe(RUN_CODE_INPUTS_DESCRIPTION),
  include_console: z
    .boolean()
    .optional()
    .describe('Include console.log debugging trace in the successful result. Defaults to false.'),
  // Non-positive is rejected because `setTimeout(fn, 0)` fires promptly; it
  // does not disable the timer. Values above 2**31-1 wrap to ~1 ms in Node.
  timeout_ms: relaxedNumber
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Wall-clock limit for the script. Defaults to ${DEFAULT_TIMEOUT_MS}.`),
  description: z.string().describe('One short line describing what the script does, shown to the user.'),
});

export type RunCodeParams = z.infer<typeof runCodeParametersSchema>;

// JSON Schema already describes JSON values. Avoid recursive references in the
// advertised inputs shape; execution still uses the canonical schema above.
export const runCodeProviderParametersSchema = runCodeParametersSchema.extend({
  inputs: z.record(z.string(), z.unknown()).optional().describe(RUN_CODE_INPUTS_DESCRIPTION),
});
