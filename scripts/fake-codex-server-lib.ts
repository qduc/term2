import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

export type FakeCodexScenario =
  | 'success'
  | 'close-before-first-frame'
  | 'stall-before-first-frame'
  | 'stall-mid-stream'
  | 'close-mid-stream'
  | 'provider-error'
  | 'previous-response-not-found';

export interface FakeCodexServer {
  readonly baseUrl: string;
  readonly receivedRequests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface FakeCodexHttpServer {
  readonly baseUrl: string;
  readonly receivedRequests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startFakeCodexServer(options: {
  scenario: FakeCodexScenario;
  port?: number;
}): Promise<FakeCodexServer> {
  const receivedRequests: Array<Record<string, unknown>> = [];
  const clients = new Set<WebSocket>();
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: options.port ?? 0,
    path: '/backend-api/codex/responses',
  });

  server.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as Record<string, unknown>;
      receivedRequests.push(request);
      if (options.scenario === 'close-before-first-frame') {
        socket.terminate();
        return;
      }
      if (options.scenario === 'stall-before-first-frame') return;
      if (options.scenario === 'provider-error') {
        send(socket, {
          type: 'error',
          error: { type: 'server_error', message: 'Injected Codex server failure' },
        });
        return;
      }
      if (options.scenario === 'previous-response-not-found' && receivedRequests.length === 1) {
        send(socket, {
          type: 'error',
          error: { code: 'previous_response_not_found', message: 'Injected stale response id' },
        });
        return;
      }
      sendResponse(socket, options.scenario === 'success' || options.scenario === 'previous-response-not-found');
      if (options.scenario === 'close-mid-stream') socket.terminate();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeWebSocketServer(server, clients);
    throw new Error('Fake Codex server did not bind to a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/backend-api/codex`,
    receivedRequests,
    close: () => closeWebSocketServer(server, clients),
  };
}

export async function startFakeCodexHttpServer(options: {
  scenario: 'success' | 'missing-terminal';
}): Promise<FakeCodexHttpServer> {
  const receivedRequests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const body = await readHttpBody(request);
    receivedRequests.push(body ? (JSON.parse(body) as Record<string, unknown>) : {});
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const responseId = `resp_http_${receivedRequests.length}`;
    writeSse(response, { type: 'response.created', response: { id: responseId, status: 'in_progress' } });
    writeSse(response, { type: 'response.output_text.delta', delta: 'Hello from fake HTTP Codex' });
    if (options.scenario === 'success') {
      writeSse(response, {
        type: 'response.output_item.done',
        item: {
          id: `msg_http_${receivedRequests.length}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello from fake HTTP Codex' }],
        },
      });
      writeSse(response, {
        type: 'response.completed',
        response: {
          id: responseId,
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 5 },
        },
      });
    }
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake Codex HTTP server did not bind to a TCP port.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/backend-api/codex`,
    receivedRequests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function writeSse(response: ServerResponse, frame: Record<string, unknown>): void {
  response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
}

async function readHttpBody(request: IncomingMessage): Promise<string> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  return body;
}

function send(socket: WebSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame));
}

function sendResponse(socket: WebSocket, complete: boolean): void {
  const responseId = `resp_${Date.now()}`;
  const messageId = `msg_${Date.now()}`;
  const item = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Hello from fake Codex', annotations: [] }],
  };

  send(socket, {
    type: 'response.created',
    response: { id: responseId, status: 'in_progress', output: [] },
  });
  send(socket, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
  });
  send(socket, {
    type: 'response.output_text.delta',
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    delta: 'Hello from fake Codex',
  });
  if (!complete) return;
  send(socket, { type: 'response.output_item.done', output_index: 0, item });
  send(socket, {
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      output: [],
      usage: { input_tokens: 1, output_tokens: 4, total_tokens: 5 },
    },
  });
}

async function closeWebSocketServer(server: WebSocketServer, clients: Set<WebSocket>): Promise<void> {
  for (const client of clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
