import { z } from 'zod';
import type { AnyToolDefinition, JsonSchemaObject, ToolRegistry } from '../../tools/types.js';
import { isZodToolParameterSchema } from '../../tools/types.js';
import {
  MCP_TOOL_BINDING,
  isMcpToolDefinition,
  describeMcpTool,
} from '../../tools/system/run-code/mcp-script-surface.js';
import { RUN_CODE_EXPOSED_TOOLS } from '../../tools/system/run-code/run-code.js';

export type CallableToolDescriptor = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly callPath: 'direct' | 'run_code';
  readonly source: 'builtin' | 'mcp';
  readonly parameters: JsonSchemaObject;
  readonly effect: 'mutating' | 'unspecified';
  readonly approval: 'never' | 'possible' | 'always' | 'unknown';
  readonly server?: string;
  readonly originalTool?: string;
};

type CatalogAwareRunCode = AnyToolDefinition & {
  readonly [RUN_CODE_EXPOSED_TOOLS]?: ToolRegistry;
};

export function snapshotCallableToolCatalog(applicationTools: ToolRegistry): CallableToolDescriptor[] {
  const catalog: CallableToolDescriptor[] = [];
  for (const tool of applicationTools) catalog.push(describeCallable(tool, 'direct'));
  const runCode = applicationTools.find((tool) => tool.name === 'run_code') as CatalogAwareRunCode | undefined;
  for (const tool of runCode?.[RUN_CODE_EXPOSED_TOOLS] ?? []) catalog.push(describeCallable(tool, 'run_code'));
  return catalog;
}

const describeCallable = (tool: AnyToolDefinition, callPath: 'direct' | 'run_code'): CallableToolDescriptor => {
  const mcp = isMcpToolDefinition(tool) ? tool[MCP_TOOL_BINDING] : undefined;
  return {
    id: `${callPath}:${tool.name}`,
    name: tool.name,
    description: mcp ? String(describeMcpTool(mcp).description) : tool.description,
    callPath,
    source: mcp ? 'mcp' : 'builtin',
    parameters: jsonSchema(tool.canonicalParameters ?? tool.parameters),
    effect: tool.effect === 'mutating' ? 'mutating' : 'unspecified',
    approval: mcp
      ? 'always'
      : tool.canRequireApproval === false
      ? 'never'
      : tool.canRequireApproval === true
      ? 'possible'
      : 'unknown',
    ...(mcp ? { server: mcp.server, originalTool: mcp.tool } : {}),
  };
};

const jsonSchema = (schema: unknown): JsonSchemaObject => {
  if (isZodToolParameterSchema(schema)) {
    try {
      return z.toJSONSchema(schema, { io: 'input' }) as JsonSchemaObject;
    } catch {
      return { unconvertible: true };
    }
  }
  return schema && typeof schema === 'object' && !Array.isArray(schema)
    ? (schema as JsonSchemaObject)
    : { unconvertible: true };
};
