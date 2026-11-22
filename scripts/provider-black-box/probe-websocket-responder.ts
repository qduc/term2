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
 * free text, so only the post-write secret scan can catch it), `'jwt-name'` echoes the `name` claim of the
 * bearer JWT (a display name: only the scan's claim literals can catch it).
 *
 * `identity` adds the {@link plantedResponderIdentity} fields a real service might add and no product code
 * reads (to the response object and the `response.created` event), a top-level-shaped
 * `codex.rate_limits` event with `code_review_rate_limits`, and an unknown `codex.*` event.
 * `closeReason` closes the socket from the server, with that reason, after the final answer.
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

/** Identity-bearing values `identity: true` plants; none may survive into a written recording. */
export const plantedResponderIdentity = {
  strings: {
    org: 'org-planted-identity-0001',
    client_ip: '203.0.113.77',
    ip: '198.51.100.23',
    country: 'Plantedcountry-XY',
    customer_id: 'cus_planted_customer_0001',
    billing: 'billing-planted-customer-0001',
    request_id: '6f1c2a9e-0b7d-4c1e-9a55-2d4e8b7c1f03',
    owner_name: 'Planted Owner Name',
    owner_id: 'owner-planted-0001',
    tenant: 'tenant-planted-0001',
    profile_name: 'Planted Profile Name',
    limit_name: 'planted-limit-name-0001',
    notice: 'planted-codex-notice-0001',
  },
  numbers: { primary: 73.4375, secondary: 10079, codeReview: 41.0625, resets: 86399 },
} as const;

const ITEM_ID = 'fc_probe_fixture_0001';

export async function startProbeWebSocketResponder(
  options: {
    leak?: 'bearer' | 'account-id' | 'jwt-name';
    http?: boolean;
    identity?: boolean;
    closeReason?: string;
  } = {},
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
        : options.leak === 'jwt-name'
        ? jwtClaim(String(request.headers.authorization ?? ''), 'name')
        : '';
    client.on('message', (raw) => {
      const body = JSON.parse(raw.toString()) as Record<string, any>;
      connection.requests.push(body);
      const frames = framesFor(body, echoed);
      for (const frame of frames) client.send(JSON.stringify(frame));
      if (options.closeReason !== undefined && frames.at(-1)?.type === 'response.completed' && isAnswer(body))
        client.close(1000, options.closeReason);
    });
  });
  function framesFor(body: Record<string, any>, echoed = ''): Record<string, unknown>[] {
    const responseId = `resp_probe_${String(++responseCount).padStart(4, '0')}`;
    const frames = isAnswer(body)
      ? answerFrames(responseId, echoed ? `The fixture returned 1 for ${echoed}.` : 'The fixture returned 1.')
      : toolCallFrames(responseId);
    return options.identity ? withPlantedIdentity(frames) : frames;
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

function isAnswer(body: Record<string, any>): boolean {
  return JSON.stringify(body.input ?? []).includes('function_call_output');
}

function jwtClaim(authorization: string, claim: string): string {
  try {
    const payload = authorization.replace(/^Bearer\s+/i, '').split('.')[1] ?? '';
    return String(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))[claim] ?? '');
  } catch {
    return '';
  }
}

function withPlantedIdentity(frames: Record<string, unknown>[]): Record<string, unknown>[] {
  const planted = plantedResponderIdentity.strings;
  const numbers = plantedResponderIdentity.numbers;
  const fields = {
    org: planted.org,
    client_ip: planted.client_ip,
    ip: planted.ip,
    country: planted.country,
    customer_id: planted.customer_id,
    billing: { customer: planted.billing },
    request_id: planted.request_id,
    owner: { name: planted.owner_name, id: planted.owner_id },
    tenant: planted.tenant,
    profile: { name: planted.profile_name },
  };
  const result = frames.map((frame) => {
    const response = frame.response as Record<string, unknown> | undefined;
    const withResponse = response ? { ...frame, response: { ...response, ...fields } } : frame;
    return frame.type === 'response.created' ? { ...withResponse, ...fields } : withResponse;
  });
  result.splice(
    1,
    0,
    {
      type: 'codex.rate_limits',
      primary: { used_percent: numbers.primary, window_minutes: 300, resets_in_seconds: numbers.resets },
      secondary: { used_percent: numbers.secondary, window_minutes: 10080 },
      limit_name: planted.limit_name,
      code_review_rate_limits: { primary: { used_percent: numbers.codeReview } },
    },
    { type: 'codex.probe_notice', detail: planted.notice, account: { tier: 'planted' } },
  );
  return result;
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
