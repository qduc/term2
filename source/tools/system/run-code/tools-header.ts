import { z } from 'zod';
import { isZodToolParameterSchema, type ToolRegistry } from '../../types.js';

/** A JSON-Schema subset rich enough for the tool schemas this repo defines. */
interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode | JsonSchemaNode[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
}

const MAX_DESCRIPTION_CHARS = 140;

/** A union this long is inlined in signatures; longer enums degrade to their base type. */
const SHORT_ENUM_MAX_CHARS = 80;
/** Nested object properties expand to this depth before degrading to `object`. */
const MAX_OBJECT_DEPTH = 3;

export const RUN_CODE_ESSENTIAL_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'read_code_outline',
  'code_context_search',
  'apply_patch',
  'create_file',
  'search_replace',
]);

function renderFields(node: JsonSchemaNode, depth: number): string[] {
  const required = new Set(node.required ?? []);
  return Object.entries(node.properties ?? {}).map(([key, value]) => {
    const rendered = renderType(value, depth);
    return `${key}${required.has(key) ? '' : '?'}: ${rendered}`;
  });
}

function renderType(node: JsonSchemaNode | undefined, depth = 0): string {
  if (!node) return 'unknown';
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum?.length) {
    const rendered = node.enum.map((value) => JSON.stringify(value)).join('|');
    if (rendered.length <= SHORT_ENUM_MAX_CHARS) return rendered;
    // A long union (e.g. the skill catalogue) would drown the signature; the
    // real schema (and any zod failure issue) still names every value.
    return node.enum.every((value) => typeof value === 'number') ? 'number' : 'string';
  }
  const union = node.anyOf ?? node.oneOf;
  if (union?.length) {
    const parts = [...new Set(union.map((member) => renderType(member, depth)))].filter((part) => part !== 'unknown');
    return parts.length === 0 ? 'unknown' : parts.join('|');
  }
  const type = Array.isArray(node.type) ? node.type.filter((entry) => entry !== 'null')[0] : node.type;
  switch (type) {
    case 'string':
    case 'boolean':
    case 'null':
      return type;
    case 'number':
    case 'integer':
      return 'number';
    case 'array':
      return `${renderType(Array.isArray(node.items) ? node.items[0] : node.items, depth)}[]`;
    case 'object':
    default:
      return node.properties && depth < MAX_OBJECT_DEPTH ? `{ ${renderFields(node, depth + 1).join(', ')} }` : 'object';
  }
}

function schemaFor(parameters: unknown): JsonSchemaNode {
  if (!isZodToolParameterSchema(parameters)) return (parameters as JsonSchemaNode) ?? {};
  try {
    return z.toJSONSchema(parameters, { io: 'input' }) as JsonSchemaNode;
  } catch {
    // A schema the converter cannot express still gets a callable member; the
    // host validates it for real at call time.
    return {};
  }
}

const oneLine = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_DESCRIPTION_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()}…`;
};

/**
 * The call shape for one tool — `tools.name({ field: type, ... })` — with short
 * enums inlined, nested object shapes expanded, and long enums degraded.
 * Shared by the header and the invalid-parameters failure message, so the two
 * never drift apart.
 */
export function renderCompactSignature(tool: {
  name: string;
  parameters: unknown;
  canonicalParameters?: unknown;
}): string {
  const targetSchema = tool.canonicalParameters ?? tool.parameters;
  const fields = renderFields(schemaFor(targetSchema), 0);
  return `tools.${tool.name}({ ${fields.join(', ')} })`.replace('({  })', '()');
}

/** The header bullet for a fully rendered tool: signature plus one-line description and declared return shape. */
export function renderDetailedEntry(tool: ToolRegistry[number]): string {
  const description = typeof tool.description === 'string' && tool.description ? ` — ${oneLine(tool.description)}` : '';
  // Declared return shapes only: without one, a script has to probe for the
  // shape, which cost observed runs several turns each.
  const returns =
    typeof tool.scriptedReturnShape === 'string' && tool.scriptedReturnShape
      ? `\n    returns ${tool.scriptedReturnShape}`
      : '';
  return `- ${renderCompactSignature(tool)}${description}${returns}`;
}

/**
 * Renders the catalogue of `tools.*` members a script can call.
 *
 * The shapes here are approximate by construction: they are the structural part
 * of each Zod schema, and a schema's cross-field rules (`superRefine`) have no
 * structural form. The host's `safeParse` is the authority, so the header says
 * so rather than implying the shapes are a contract.
 */
export function renderToolsHeader(registry: ToolRegistry): string {
  if (registry.length === 0) return '';
  const essential = registry.filter((tool) => RUN_CODE_ESSENTIAL_TOOLS.has(tool.name));
  const other = registry.filter((tool) => !RUN_CODE_ESSENTIAL_TOOLS.has(tool.name));
  const lines = [
    'Available inside the script (parameter shapes are approximate; each call is validated against the tool’s real schema):',
    'Use tools.describe(name) when you need the full schema and description for a tool.',
    ...(essential.length > 0 ? ['Essential tools:', ...essential.map(renderDetailedEntry)] : []),
    ...(other.length > 0
      ? [
          '',
          'Other tools (names only; schemas are available on demand):',
          ...other.map((tool) => `- tools.${tool.name}`),
        ]
      : []),
  ];
  return lines.join('\n');
}
