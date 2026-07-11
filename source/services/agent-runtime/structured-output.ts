import type { RunOutputFormat, RunErrorCode } from './types.js';

/**
 * Supported JSON Schema keywords for the bounded inline validator.
 * Keywords outside this set are rejected before execution with a typed error.
 */
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'additionalProperties',
  'description',
  'title',
  // $schema is silently stripped so callers can pass standard schemas
  '$schema',
]);

/**
 * Validate that a JSON Schema only uses supported keywords.
 * Returns an array of unsupported keyword names, or empty if valid.
 */
export function validateSchemaKeywords(schema: Record<string, unknown>): string[] {
  const unsupported: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      unsupported.push(key);
    }
    // Recursively check nested schemas in properties/items
    if (key === 'properties' && typeof schema[key] === 'object' && schema[key] !== null) {
      const props = schema[key] as Record<string, unknown>;
      for (const propKey of Object.keys(props)) {
        const propSchema = props[propKey];
        if (typeof propSchema === 'object' && propSchema !== null && !Array.isArray(propSchema)) {
          const nested = validateSchemaKeywords(propSchema as Record<string, unknown>);
          for (const kw of nested) {
            unsupported.push(`properties.${propKey}.${kw}`);
          }
        }
      }
    }
    if (key === 'items' && typeof schema[key] === 'object' && schema[key] !== null && !Array.isArray(schema[key])) {
      const nested = validateSchemaKeywords(schema[key] as Record<string, unknown>);
      for (const kw of nested) {
        unsupported.push(`items.${kw}`);
      }
    }
  }
  return unsupported;
}

/**
 * Validate an output value against a JSON Schema subset.
 * Returns an array of error message strings, or empty if valid.
 *
 * Supported keywords: type, properties, required, items, enum, additionalProperties.
 */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>, path = '$'): string[] {
  const errors: string[] = [];

  // enum check
  if ('enum' in schema && Array.isArray(schema.enum)) {
    const enumValues = schema.enum;
    let found = false;
    for (const ev of enumValues) {
      if (deepEqual(value, ev)) {
        found = true;
        break;
      }
    }
    if (!found) {
      errors.push(`${path}: value must be one of the enum values`);
    }
    return errors; // enum is terminal; skip other checks when present
  }

  // type check
  const schemaType = schema.type;
  if (schemaType !== undefined) {
    const typeResult = checkType(value, schemaType as string | string[], path);
    if (typeResult) errors.push(typeResult);
  }

  // additionalProperties check
  if (schema.additionalProperties === false && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const props = schema.properties;
    if (typeof props === 'object' && props !== null) {
      const knownKeys = new Set(Object.keys(props));
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!knownKeys.has(key)) {
          errors.push(`${path}.${key}: additional properties are not allowed`);
        }
      }
    }
  }

  // properties check
  if (
    typeof schema.properties === 'object' &&
    schema.properties !== null &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const props = schema.properties as Record<string, unknown>;
    const valueObj = value as Record<string, unknown>;

    // required check
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in valueObj)) {
          errors.push(`${path}: missing required property "${reqKey}"`);
        }
      }
    }

    for (const [key, propSchema] of Object.entries(props)) {
      if (key in valueObj && typeof propSchema === 'object' && propSchema !== null && !Array.isArray(propSchema)) {
        const nestedErrors = validateAgainstSchema(
          valueObj[key],
          propSchema as Record<string, unknown>,
          `${path}.${key}`,
        );
        errors.push(...nestedErrors);
      }
    }
  }

  // items check for arrays
  if (schema.items && Array.isArray(value)) {
    const itemSchema = schema.items;
    if (typeof itemSchema === 'object' && itemSchema !== null && !Array.isArray(itemSchema)) {
      for (let i = 0; i < value.length; i++) {
        const nestedErrors = validateAgainstSchema(value[i], itemSchema as Record<string, unknown>, `${path}[${i}]`);
        errors.push(...nestedErrors);
      }
    }
  }

  return errors;
}

/** Check the type of a value against the schema type(s). */
function checkType(value: unknown, schemaType: string | string[], path: string): string | undefined {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];

  for (const t of types) {
    if (matchesType(value, t)) return undefined;
  }

  return `${path}: expected ${Array.isArray(schemaType) ? schemaType.join('|') : schemaType}, got ${typeof value}`;
}

function matchesType(value: unknown, t: string): boolean {
  switch (t) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

/** Simple deep equality for enum value comparison. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => deepEqual((a as any)[key], (b as any)[key]));
}

/**
 * Validate the schema itself (keywords check) and return a structured
 * error or null. The caller should reject execution if non-null.
 */
export function validateOutputSchema(output: RunOutputFormat): { code: RunErrorCode; message: string } | null {
  if (!output || typeof output.schema !== 'object' || output.schema === null) {
    return { code: 'invalid_schema', message: 'Output schema must be a non-null object.' };
  }
  const unsupported = validateSchemaKeywords(output.schema);
  if (unsupported.length > 0) {
    return {
      code: 'invalid_schema',
      message: `Schema contains unsupported keywords: ${unsupported.join(
        ', ',
      )}. The built-in validator only supports: type, properties, required, items, enum, additionalProperties.`,
    };
  }
  return null;
}

/**
 * Append a JSON-only output contract to the model-visible instructions.
 * This is appended as a distinct section so the model knows it MUST
 * produce valid JSON matching the schema.
 */
export function formatOutputContract(output: RunOutputFormat): string {
  const schemaJson = JSON.stringify(output.schema, null, 2);
  return `\n## Output Format

You MUST respond with a single valid JSON object as your entire output. Do NOT include any explanatory text, markdown fences, or other content.
The JSON must conform to the following JSON Schema:

\`\`\`json
${schemaJson}
\`\`\`
${output.name ? `\nSchema name: ${output.name}` : ''}`;
}

/**
 * Parse and validate a completed output string against a JSON Schema.
 * Returns { value: T } on success, or { error: ... } on validation failure.
 */
export function parseAndValidateOutput<T>(
  rawOutput: string,
  output: RunOutputFormat,
): { value: T } | { error: { code: RunErrorCode; message: string } } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (err: any) {
    return {
      error: {
        code: 'invalid_output',
        message: `Failed to parse output as JSON: ${err.message}`,
      },
    };
  }

  const validationErrors = validateAgainstSchema(parsed, output.schema);
  if (validationErrors.length > 0) {
    return {
      error: {
        code: 'invalid_output',
        message: `Output does not match the requested schema: ${validationErrors.join('; ')}`,
      },
    };
  }

  return { value: parsed as T };
}
