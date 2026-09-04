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
  allOf?: JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
  description?: string;
}

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const quoteKey = (key: string): string => (TS_IDENTIFIER.test(key) ? key : JSON.stringify(key));

/**
 * Renders a TypeScript type for a JSON-Schema node.
 *
 * Anything this emitter does not recognise becomes `unknown` rather than `any`:
 * a wrong-but-permissive type would let the model write a call that the bridge
 * then rejects at runtime, which is the failure mode the types exist to prevent.
 */
function renderType(node: JsonSchemaNode | undefined, indent: string): string {
  if (!node) return 'unknown';
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum?.length) return node.enum.map((value) => JSON.stringify(value)).join(' | ');

  const union = node.anyOf ?? node.oneOf;
  if (union?.length) {
    const parts = union.map((entry) => renderType(entry, indent)).filter((part) => part !== 'unknown');
    if (parts.length === 0) return 'unknown';
    return Array.from(new Set(parts)).join(' | ');
  }
  if (node.allOf?.length === 1) return renderType(node.allOf[0], indent);

  const type = Array.isArray(node.type) ? node.type.filter((entry) => entry !== 'null')[0] : node.type;
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = Array.isArray(node.items) ? node.items[0] : node.items;
      const rendered = renderType(items, indent);
      return rendered.includes(' | ') ? `Array<${rendered}>` : `${rendered}[]`;
    }
    case 'object':
      return renderObject(node, indent);
    default:
      return node.properties ? renderObject(node, indent) : 'unknown';
  }
}

function renderObject(node: JsonSchemaNode, indent: string): string {
  const properties = node.properties;
  if (!properties || Object.keys(properties).length === 0) {
    return typeof node.additionalProperties === 'object'
      ? `Record<string, ${renderType(node.additionalProperties, indent)}>`
      : 'Record<string, unknown>';
  }
  const required = new Set(node.required ?? []);
  const inner = `${indent}  `;
  const lines = Object.entries(properties).map(([key, value]) => {
    const optional = required.has(key) ? '' : '?';
    const doc = value.description ? `${inner}/** ${escapeComment(value.description)} */\n` : '';
    return `${doc}${inner}${quoteKey(key)}${optional}: ${renderType(value, inner)};`;
  });
  return `{\n${lines.join('\n')}\n${indent}}`;
}

const escapeComment = (text: string): string => text.replace(/\*\//g, '*\\/').replace(/\s+/g, ' ').trim();

function schemaFor(parameters: unknown): JsonSchemaNode {
  if (!isZodToolParameterSchema(parameters)) return (parameters as JsonSchemaNode) ?? {};
  try {
    return z.toJSONSchema(parameters, { io: 'input' }) as JsonSchemaNode;
  } catch {
    // A schema the converter cannot express still gets a callable binding; the
    // bridge validates it for real at call time.
    return {};
  }
}

export interface GeneratedRuntime {
  /** Source of the module the script imports, defining the `tools` namespace. */
  toolsModule: string;
  /** Source of the entry file: wires `tools` into scope and runs the user code. */
  runnerModule: string;
}

export interface GenerateRuntimeOptions {
  registry: ToolRegistry;
  socketPath: string;
  /** File name of the tools module, used in the runner's import specifier. */
  toolsModuleName?: string;
}

export function generateRuntime(options: GenerateRuntimeOptions): GeneratedRuntime {
  const { registry, socketPath, toolsModuleName = 'tools.ts' } = options;

  const entries = registry.map((tool) => {
    const schema = schemaFor(tool.parameters);
    const paramsType = renderType(schema, '  ');
    const doc = tool.description ? `  /** ${escapeComment(tool.description)} */\n` : '';
    // The bridge defaults a missing payload to {}, so a tool that requires
    // nothing must also be callable as `tools.name()`.
    const optional = (schema.required?.length ?? 0) === 0 ? '?' : '';
    return `${doc}  ${quoteKey(tool.name)}: (params${optional}: ${paramsType}) => Promise<unknown>;`;
  });

  const bindings = registry
    .map((tool) => `  ${quoteKey(tool.name)}: (params: unknown) => call(${JSON.stringify(tool.name)}, params),`)
    .join('\n');

  const toolsModule = `// Generated for a single run_code execution. Do not edit.
import net from 'node:net';

const SOCKET_PATH = ${JSON.stringify(socketPath)};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const pending = new Map<number, Pending>();
let nextId = 1;
let socket: net.Socket | undefined;
let connecting: Promise<net.Socket> | undefined;

function connect(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return Promise.resolve(socket);
  if (connecting) return connecting;
  connecting = new Promise<net.Socket>((resolve, reject) => {
    const created = net.createConnection(SOCKET_PATH);
    created.setEncoding('utf8');
    let buffer = '';
    created.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\\n');
        if (!line.trim()) continue;
        let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
        if (!waiter) continue;
        pending.delete(message.id as number);
        if (message.ok) waiter.resolve(message.result);
        else waiter.reject(new Error(message.error ?? 'tool call failed'));
      }
    });
    // A dropped socket must fail every in-flight call; otherwise the script
    // hangs on a promise that can never settle and dies at the timeout instead.
    const failAll = (error: Error) => {
      for (const [, waiter] of pending) waiter.reject(error);
      pending.clear();
    };
    // Clearing both handles matters: a settled rejected \`connecting\` promise or a
    // dead socket would otherwise be reused, failing every later call instantly.
    const forget = () => {
      socket = undefined;
      connecting = undefined;
    };
    created.on('error', (error: Error) => {
      forget();
      failAll(error);
      reject(error);
    });
    created.on('close', () => {
      forget();
      failAll(new Error('tool bridge connection closed'));
    });
    created.on('connect', () => {
      socket = created;
      resolve(created);
    });
  });
  return connecting;
}

async function call(tool: string, params: unknown): Promise<unknown> {
  const connection = await connect();
  const id = nextId++;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    connection.write(JSON.stringify({ id, tool, params: params ?? {} }) + '\\n');
  });
}

export interface Tools {
${entries.join('\n')}
}

export const tools: Tools = {
${bindings}
} as Tools;

/** Releases the bridge connection so the script's process can exit. */
export function __disconnect(): void {
  socket?.destroy();
  socket = undefined;
  connecting = undefined;
}
`;

  const runnerModule = `// Generated for a single run_code execution. Do not edit.
import { tools, __disconnect } from './${toolsModuleName}';

// Also exposed globally so a script can use \`tools\` without an import.
(globalThis as Record<string, unknown>).tools = tools;

const main = async (): Promise<void> => {
${'/* user code begins */'}
__USER_CODE__
};

try {
  await main();
} finally {
  __disconnect();
}
`;

  return { toolsModule, runnerModule };
}

/**
 * Splices user code into the generated runner.
 *
 * The replacement must be a function: with a string replacement, `$'`, `$&`,
 * `` $` `` and `$$` inside the user's own source are expanded as replacement
 * patterns, which duplicates parts of the runner into the middle of the script
 * and corrupts it.
 */
export function buildRunnerSource(runnerModule: string, userCode: string): string {
  return runnerModule.replace('__USER_CODE__', () => userCode);
}
