import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A loopback stand-in for the Codex / OpenAI Responses WebSocket endpoint that answers the recorder's
 * tool-continuation probe the way the real service does: the first `response.create` gets a `fixture` tool
 * call, a later one (carrying the tool output) gets a short answer. It accepts whatever request body the
 * product sends, so `provider:record --provider codex` can run end to end against it with a fake login.
 * Each response carries a `codex.rate_limits` event and identity-bearing fields (`user`,
 * `prompt_cache_key`, `metadata`) like the live service may, so the scrubber has something to remove.
 *
 * `leak` makes the server echo a handshake value into the answer text, as a service might in an error or a
 * greeting: `'bearer'` echoes the access token (token-shaped, so the capture-time scrubber removes it),
 * `'account-id'` echoes the `chatgpt-account-id` header value (an opaque id no scrubber rule recognises in
 * free text, so only the post-write secret scan can catch it).
 */
export type ProbeWebSocketResponder = {
  /** http://127.0.0.1:<port>; the Responses WebSocket URL is `<baseUrl>/responses` (as ws://). */
  readonly baseUrl: string;
  readonly connections: Array<{ url: string; headers: IncomingHttpHeaders; requests: Record<string, any>[] }>;
  /** HTTP Responses requests (served only with `http: true`; otherwise refused with 404). */
  readonly httpRequests: Array<{ url: string; headers: IncomingHttpHeaders; body: Record<string, any> }>;
  close(): Promise<void>;
};

const CALL_ID = 'call_probe_fixture_0001';
const ITEM_ID = 'fc_probe_fixture_0001';

export async function startProbeWebSocketResponder(
  options: { leak?: 'bearer' | 'account-id'; http?: boolean } = {},
): Promise<ProbeWebSocketResponder> {
  const connections: ProbeWebSocketResponder['connections'] = [];
  const sockets = new Set<Socket>();
  const clients = new Set<WebSocket>();
  let responseCount = 0;
  const httpRequests: ProbeWebSocketResponder['httpRequests'] = [];
  const httpServer = createServer(async (request, response) => {
    // Unless HTTP is asked for, refuse it: a WebSocket recording must not fall back to HTTP unnoticed.
    if (!options.http || request.method !== 'POST') return void response.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
    httpRequests.push({ url: request.url ?? '/', headers: request.headers, body });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const frame of framesFor(body)) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const wsServer = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) =>
    wsServer.handleUpgrade(request, socket, head, (client) => wsServer.emit('connection', client, request)),
  );
  wsServer.on('connection', (client: WebSocket, request) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    const connection = { url: request.url ?? '/', headers: request.headers, requests: [] as Record<string, any>[] };
    connections.push(connection);
    const echoed =
      options.leak === 'bearer'
        ? String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        : options.leak === 'account-id'
        ? String(request.headers['chatgpt-account-id'] ?? '')
        : '';
    client.on('message', (raw) => {
      const body = JSON.parse(raw.toString()) as Record<string, any>;
      connection.requests.push(body);
      for (const frame of framesFor(body, echoed)) client.send(JSON.stringify(frame));
    });
  });
  function framesFor(body: Record<string, any>, echoed = ''): Record<string, unknown>[] {
    const responseId = `resp_probe_${String(++responseCount).padStart(4, '0')}`;
    const hasToolOutput = JSON.stringify(body.input ?? []).includes('function_call_output');
    return hasToolOutput
      ? answerFrames(responseId, echoed ? `The fixture returned 1 for ${echoed}.` : 'The fixture returned 1.')
      : toolCallFrames(responseId);
  }
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('probe responder did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    connections,
    httpRequests,
    close: async () => {
      for (const client of clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function responseObject(id: string, status: string, output: unknown[]) {
  return {
    id,
    object: 'response',
    status,
    output,
    user: 'user-probe-identity-0001',
    prompt_cache_key: 'probe-cache-key-0001',
    metadata: { session: 'probe-session-0001' },
  };
}

function rateLimits() {
  return {
    type: 'codex.rate_limits',
    plan_type: 'plus',
    rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 4000 } },
  };
}

function toolCallFrames(responseId: string): Record<string, unknown>[] {
  const item = {
    id: ITEM_ID,
    type: 'function_call',
    status: 'in_progress',
    arguments: '',
    call_id: CALL_ID,
    name: 'fixture',
  };
  const done = { ...item, status: 'completed', arguments: '{"a":1}' };
  return [
    { type: 'response.created', response: responseObject(responseId, 'in_progress', []) },
    rateLimits(),
    { type: 'response.output_item.added', item, output_index: 0 },
    { type: 'response.function_call_arguments.delta', item_id: ITEM_ID, delta: '{"a":', output_index: 0 },
    { type: 'response.function_call_arguments.delta', item_id: ITEM_ID, delta: '1}', output_index: 0 },
    { type: 'response.function_call_arguments.done', item_id: ITEM_ID, arguments: '{"a":1}', output_index: 0 },
    { type: 'response.output_item.done', item: done, output_index: 0 },
    { type: 'response.completed', response: responseObject(responseId, 'completed', [done]) },
  ];
}

function answerFrames(responseId: string, text: string): Record<string, unknown>[] {
  const message = {
    id: 'msg_probe_fixture_0001',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  return [
    { type: 'response.created', response: responseObject(responseId, 'in_progress', []) },
    { type: 'response.output_text.delta', item_id: message.id, delta: text, output_index: 0, content_index: 0 },
    { type: 'response.output_text.done', item_id: message.id, text, output_index: 0, content_index: 0 },
    { type: 'response.output_item.done', item: message, output_index: 0 },
    { type: 'response.completed', response: responseObject(responseId, 'completed', [message]) },
  ];
}
