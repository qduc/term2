import {
  McpCallError,
  type McpServerSnapshot,
  type McpToolDescriptor,
  type McpToolSource,
} from '../../../services/mcp/mcp-tool-source.js';
import type { AnyToolDefinition, FormatCommandMessage, JsonSchemaObject } from '../../types.js';

export const MCP_TOOL_BINDING = Symbol('term2.mcpToolBinding');
const MAX_DESCRIPTION_CHARS = 2000;

export interface McpToolBinding {
  readonly [MCP_TOOL_BINDING]: true;
  readonly source: McpToolSource;
  readonly server: string;
  readonly tool: string;
  readonly descriptor: McpToolDescriptor;
}

export type McpToolDefinition = AnyToolDefinition & { readonly [MCP_TOOL_BINDING]: McpToolBinding };

const noopFormatter = (() => []) as unknown as FormatCommandMessage;

/** The only names MCP may contribute to the flat `tools` namespace. */
export const mcpMemberName = (server: string, tool: string): string => {
  const raw = `${server}__${tool}`.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[0-9]/.test(raw) ? `_${raw}` : raw;
};

const isObjectSchema = (schema: JsonSchemaObject): boolean => schema.type === undefined || schema.type === 'object';

const primitiveMatches = (value: unknown, type: unknown): boolean => {
  if (type === undefined) return true;
  if (Array.isArray(type)) return type.some((entry) => primitiveMatches(value, entry));
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
};

/** Boundary validation without adding a JSON Schema dependency. */
export const validateMcpArguments = (schema: JsonSchemaObject, value: unknown): string | null => {
  if (!isObjectSchema(schema)) return 'arguments must satisfy an object-root JSON Schema';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'arguments must be an object';
  const record = value as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required)
    if (typeof key === 'string' && !(key in record)) return `missing required property "${key}"`;
  const properties = schema.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, property] of Object.entries(properties)) {
      if (
        key in record &&
        property &&
        typeof property === 'object' &&
        !primitiveMatches(record[key], (property as JsonSchemaObject).type)
      ) {
        return `property "${key}" must be ${String((property as JsonSchemaObject).type)}`;
      }
    }
  }
  return null;
};

export const describeMcpTool = (binding: McpToolBinding): Record<string, unknown> => ({
  name: mcpMemberName(binding.server, binding.tool),
  server: binding.server,
  tool: binding.tool,
  description: `[server-provided text] ${(binding.descriptor.description ?? '').slice(0, MAX_DESCRIPTION_CHARS)}`,
  parameters: binding.descriptor.inputSchema,
  ...(binding.descriptor.outputSchema ? { outputSchema: binding.descriptor.outputSchema } : {}),
});

export const isMcpToolDefinition = (tool: AnyToolDefinition): tool is McpToolDefinition =>
  (tool as Partial<McpToolDefinition>)[MCP_TOOL_BINDING] !== undefined;

export interface McpCatalog {
  readonly snapshots: readonly McpServerSnapshot[];
  readonly tools: readonly McpToolDefinition[];
  readonly collisions: readonly string[];
}

export const createMcpCatalog = (source: McpToolSource, builtInNames: ReadonlySet<string>): McpCatalog => {
  const snapshots = source.snapshot();
  const candidates: McpToolDefinition[] = [];
  const collisions: string[] = [];
  const seen = new Map<string, string>();
  for (const server of snapshots) {
    if (server.state !== 'ready') continue;
    for (const descriptor of server.tools) {
      const member = mcpMemberName(server.name, descriptor.name);
      const previous = seen.get(member);
      if (builtInNames.has(member) || previous) {
        collisions.push(`${server.name}/${descriptor.name} -> ${member} collides with ${previous ?? 'built-in tool'}`);
        if (previous) {
          const index = candidates.findIndex((candidate) => candidate.name === member);
          if (index >= 0) candidates.splice(index, 1);
        }
        seen.set(member, `${server.name}/${descriptor.name}`);
        continue;
      }
      seen.set(member, `${server.name}/${descriptor.name}`);
      const binding = {
        [MCP_TOOL_BINDING]: true as const,
        source,
        server: server.name,
        tool: descriptor.name,
        descriptor,
      };
      candidates.push({
        name: member,
        description: `MCP tool ${server.name}/${descriptor.name}`,
        parameters: descriptor.inputSchema,
        effect: descriptor.annotations?.readOnlyHint === true ? undefined : 'mutating',
        needsApproval: () => true,
        execute: async (args, context) => {
          try {
            const result = await source.callTool(server.name, descriptor.name, args as Record<string, unknown>, {
              signal: (context as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal,
            });
            if (result.isError) throw new Error(mcpTextResult(result.content));
            if (result.structuredContent !== undefined) return result.structuredContent;
            return mcpTextResult(result.content);
          } catch (error) {
            const message = error instanceof McpCallError ? `[${error.code}] ${error.message}` : String(error);
            throw new Error(message);
          }
        },
        formatCommandMessage: noopFormatter,
        [MCP_TOOL_BINDING]: binding,
      } as McpToolDefinition);
    }
  }
  return { snapshots, tools: candidates, collisions };
};

export const mcpTextResult = (content: readonly unknown[]): string =>
  content
    .map((block) => {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        return typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '';
      }
      return `[${String((block as { type?: unknown } | null)?.type ?? 'unknown')} content omitted]`;
    })
    .join('\n');

export const renderMcpCatalog = (catalog: McpCatalog): string => {
  if (catalog.snapshots.length === 0) return '';
  const lines = ['MCP tools (script-only; use tools.describe("<member>") for server-provided schema):'];
  for (const server of catalog.snapshots) {
    const members = catalog.tools
      .filter((tool) => tool[MCP_TOOL_BINDING].server === server.name)
      .map((tool) => tool.name);
    const error = server.state === 'failed' && server.error ? ` — ${server.error.slice(0, 160)}` : '';
    lines.push(
      `- ${server.name}: ${server.state}, ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}${error}`,
    );
    if (members.length) lines.push(`  members: ${members.join(', ')}`);
  }
  for (const collision of catalog.collisions) lines.push(`- collision: ${collision}`);
  return lines.join('\n');
};
