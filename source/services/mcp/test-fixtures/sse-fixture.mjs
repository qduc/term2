// Legacy HTTP+SSE fixture, hand-rolled: the 2026-07-28 spec removed this
// transport, so no current SDK server hosts it. GET /sse opens the event
// stream and announces the POST endpoint; POST /message?sessionId=... carries
// JSON-RPC messages, answered on the SSE stream.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const sessions = new Map();
const tools = [
  {
    name: 'echo',
    description: 'echoes its arguments',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  },
  { name: 'fail', description: 'always reports a tool failure', inputSchema: { type: 'object', properties: {} } },
];

function handleMessage(message, stream, post) {
  if (message.id === undefined || message.id === null) {
    post.writeHead(202).end();
    return;
  }
  const { id, method, params } = message;
  let result;
  if (method === 'initialize') {
    result = {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'sse-fixture', version: '1.0.0' },
    };
  } else if (method === 'tools/list') {
    result = { tools };
  } else if (method === 'ping') {
    result = {};
  } else if (method === 'tools/call') {
    result =
      params?.name === 'echo'
        ? { content: [{ type: 'text', text: `echo:${JSON.stringify(params.arguments ?? {})}` }] }
        : params?.name === 'fail'
        ? { content: [{ type: 'text', text: 'boom' }], isError: true }
        : { error: { code: -32602, message: `unknown tool ${params?.name}` } };
  } else {
    result = { error: { code: -32601, message: `method not found: ${method}` } };
  }
  const response = result.error ? { jsonrpc: '2.0', id, error: result.error } : { jsonrpc: '2.0', id, result };
  stream.write(`event: message
data: ${JSON.stringify(response)}

`);
  post.writeHead(202).end();
}

const http = createServer((req, res) => {
  if (req.url === '/sse' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const sessionId = randomUUID();
    sessions.set(sessionId, res);
    res.write(`event: endpoint
data: /message?sessionId=${sessionId}

`);
    req.on('close', () => sessions.delete(sessionId));
    return;
  }
  if (req.url?.startsWith('/message') && req.method === 'POST') {
    const stream = sessions.get(new URL(req.url, 'http://fixture').searchParams.get('sessionId'));
    if (!stream) {
      res.writeHead(404).end('unknown session');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => handleMessage(JSON.parse(Buffer.concat(chunks).toString('utf8')), stream, res));
    return;
  }
  res.writeHead(404).end();
});
http.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: http.address().port }) + '\n'));
