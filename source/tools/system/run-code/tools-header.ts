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

function renderType(node: JsonSchemaNode | undefined): string {
  if (!node) return 'unknown';
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum?.length) return node.enum.map((value) => JSON.stringify(value)).join('|');
  const union = node.anyOf ?? node.oneOf;
  if (union?.length) {
    const parts = [...new Set(union.map(renderType))].filter((part) => part !== 'unknown');
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
      return `${renderType(Array.isArray(node.items) ? node.items[0] : node.items)}[]`;
    case 'object':
      return 'object';
    default:
      return node.properties ? 'object' : 'unknown';
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
 * Renders the catalogue of `tools.*` members a script can call.
 *
 * The shapes here are approximate by construction: they are the structural part
 * of each Zod schema, and a schema's cross-field rules (`superRefine`) have no
 * structural form. The host's `safeParse` is the authority, so the header says
 * so rather than implying the shapes are a contract.
 */
export function renderToolsHeader(registry: ToolRegistry): string {
  if (registry.length === 0) return '';
  const lines = registry.map((tool) => {
    const schema = schemaFor(tool.parameters);
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).map(
      ([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${renderType(value)}`,
    );
    const signature = `tools.${tool.name}({ ${fields.join(', ')} })`.replace('({  })', '()');
    const description =
      typeof tool.description === 'string' && tool.description ? ` — ${oneLine(tool.description)}` : '';
    return `- ${signature}${description}`;
  });
  return [
    'Available inside the script (parameter shapes are approximate; each call is validated against the tool’s real schema):',
    ...lines,
  ].join('\n');
}
