// Minimal MCP server over stdio whose tools/list always fails with a JSON-RPC
// error, so the client's first catalog fetch rejects after a clean handshake.
import { createInterface } from 'node:readline';

if (process.env.MCP_FIXTURE_PID_FILE) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid));
  process.on('exit', () => fs.rmSync(process.env.MCP_FIXTURE_PID_FILE, { force: true }));
}

function handle(message, reply) {
  if (Object.prototype.hasOwnProperty.call(message, 'id') === false || message.id === undefined) return;
  const { id, method } = message;
  if (method === 'initialize') {
    reply({
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stdio-bad-list', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    reply({ id, error: { code: -32000, message: 'tool catalog is broken' } });
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
