import { z, type ZodTypeAny } from 'zod';

type JsonSchemaNode = Record<string, unknown>;

/** Keywords whose value is one subschema. */
const SCHEMA_KEYWORDS = [
  'additionalProperties',
  'items',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LIST_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const;
/** Keywords whose value maps arbitrary names to subschemas; the names are data, never keywords. */
const SCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const;

const isNode = (value: unknown): value is JsonSchemaNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{ "type": "string" }` and nothing else: true of every JSON object key. */
const isBareStringSchema = (value: unknown): boolean =>
  isNode(value) && Object.keys(value).length === 1 && value.type === 'string';

function cleanNode(node: JsonSchemaNode): JsonSchemaNode {
  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    // Zod prints `.int()` as the IEEE safe-integer range. Those are the limits
    // of the number format, not a constraint a caller chose; a real bound has
    // another value and is kept. The Zod schema still enforces the range locally.
    if (node.type === 'integer') {
      if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
      if (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) continue;
    }
    if (key === 'propertyNames' && isBareStringSchema(value)) continue;
    if ((SCHEMA_KEYWORDS as readonly string[]).includes(key) && isNode(value)) {
      out[key] = cleanNode(value);
    } else if ((SCHEMA_LIST_KEYWORDS as readonly string[]).includes(key) && Array.isArray(value)) {
      out[key] = value.map((entry) => (isNode(entry) ? cleanNode(entry) : entry));
    } else if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(key) && isNode(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, isNode(entry) ? cleanNode(entry) : entry]),
      );
    } else {
      // Everything else — including `default`, `const`, `enum` and `examples`,
      // whose values are data — is copied by reference, unread.
      out[key] = value;
    }
  }
  return out;
}

/**
 * The JSON Schema a model sees for a tool whose parameters Term2 defines in Zod.
 *
 * It is `z.toJSONSchema(schema)` minus the fields that carry no information for
 * a model or for a provider that validates arguments, which would otherwise be
 * repeated in every request:
 *
 * - the root `$schema` dialect URL;
 * - `maximum`/`minimum` equal to the safe-integer limits on an `integer`;
 * - `propertyNames: { "type": "string" }`.
 *
 * Nothing else is changed, and key order is preserved. Use this wherever a Zod
 * schema becomes a model-facing tool definition. Do not pass it a schema Term2
 * did not author (an MCP server's `inputSchema`): there `$schema` may select a
 * dialect that changes what other keywords mean, so those go out unchanged.
 * Local parsing, validation and approval keep using the Zod schema itself.
 */
export function modelToolJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const { $schema: _dialect, ...root } = z.toJSONSchema(schema) as JsonSchemaNode;
  return cleanNode(root);
}
