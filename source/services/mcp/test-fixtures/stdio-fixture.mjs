// Minimal MCP server over stdio (newline-delimited JSON-RPC), hand-rolled so the
// test exercises the real wire protocol without depending on an SDK server.
// Tools are listed across two pages to force the client through pagination.
import { createInterface } from 'node:readline';

if (process.env.MCP_FIXTURE_PID_FILE) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid));
  // Removing the file is tied to this exact process exiting, unlike a pid
  // liveness check, which breaks when the OS reuses the pid mid-test.
  process.on('exit', () => fs.rmSync(process.env.MCP_FIXTURE_PID_FILE, { force: true }));
}

const baseTools = () => [
  {
    name: 'echo',
    description: 'echoes its arguments',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  },
  {
    name: 'fail',
    description: 'always reports a tool failure',
    inputSchema: { type: 'object', properties: {} },
  },
];

const page2Tools = () => [
  {
    name: 'env_probe',
    description: 'returns one environment variable',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'crash',
    description: 'responds, then exits the process',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'replies after ten seconds (timeout/abort tests)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'refresh',
    description: 'emits tools/list_changed, then adds added_tool',
    inputSchema: { type: 'object', properties: {} },
  },
  ...(addedTool
    ? [{ name: addedTool, description: 'appeared after refresh', inputSchema: { type: 'object', properties: {} } }]
    : []),
];

let addedTool = undefined;

const text = (t) => ({ content: [{ type: 'text', text: t }] });

function handle(message, reply) {
  if (Object.prototype.hasOwnProperty.call(message, 'id') === false || message.id === undefined) return; // notification
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    if (params?.cursor === 'page-2') {
      reply({ id, result: { tools: page2Tools() } });
    } else {
      reply({ id, result: { tools: baseTools(), nextCursor: 'page-2' } });
    }
  } else if (method === 'tools/call') {
    const name = params?.name;
    if (name === 'echo') {
      reply({
        id,
        result: {
          ...text(`echo:${JSON.stringify(params.arguments ?? {})}`),
          structuredContent: { echo: params.arguments ?? {} },
        },
      });
    } else if (name === 'fail') {
      reply({ id, result: { ...text('boom'), isError: true } });
    } else if (name === 'env_probe') {
      reply({ id, result: text(process.env.MCP_FIXTURE_SECRET ?? 'unset') });
    } else if (name === 'crash') {
      reply({ id, result: text('about to crash') });
      process.stderr.write('fixture crashing on purpose\n');
      process.exit(3);
    } else if (name === 'refresh') {
      addedTool = 'added_tool';
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
      reply({ id, result: text('refreshed') });
    } else if (name === 'slow') {
      setTimeout(() => reply({ id, result: text('finally') }), 10_000);
    } else {
      reply({ id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
  } else if (method === 'ping') {
    reply({ id, result: {} });
  } else {
    reply({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  handle(JSON.parse(trimmed), (response) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n');
  });
});
