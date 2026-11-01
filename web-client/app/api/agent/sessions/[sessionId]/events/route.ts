import { TERM2_WIRE_PROTOCOL } from '@/lib/term2/types';
import { Readable } from 'node:stream';
import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { LOCAL_OWNER_USER_ID } from '@/lib/server/gateway-config.js';
import { errorResponse, rpc, validateEventCursor, LocalValidationError } from '@/lib/server/proxy';
import { attachAbortCleanup } from '@/lib/server/request-guards';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';
// The gateway owns SSE framing, heartbeats, and replay; this route is a byte
// pass-through with browser-disconnect cleanup.
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;

    const url = new URL(request.url);
    if (url.searchParams.get('format') !== TERM2_WIRE_PROTOCOL) throw new LocalValidationError('agent-wire-v2 negotiation required');
    const headerFormat = request.headers.get('x-term2-event-format');
    if (headerFormat !== null && headerFormat !== TERM2_WIRE_PROTOCOL) throw new LocalValidationError('Conflicting event format');
    const queryCursor = url.searchParams.get('after');
    const headerCursor = request.headers.get('last-event-id');
    if (queryCursor !== null && headerCursor !== null && queryCursor !== headerCursor) throw new LocalValidationError('Conflicting event cursors');
    let after = queryCursor ?? headerCursor;
    after = validateEventCursor(after);
    if (after !== null && (!Number.isSafeInteger(Number(after)) || Number(after) <= 0)) throw new LocalValidationError('Invalid accepted cursor');
    const query = `?format=${TERM2_WIRE_PROTOCOL}${after ? `&after=${after}` : ''}`;

    const upstreamPromise = term2GatewayClient.stream({
      userId: LOCAL_OWNER_USER_ID,
      purpose: 'events_connect',
      workspaceId: resolved.workspaceId,
      sessionId,
      rpcPath: `${rpc.session(sessionId)}/events`,
      query,
      signal: request.signal,
    });
    const upstream = await upstreamPromise;
    if (upstream.headers['x-term2-event-format'] !== TERM2_WIRE_PROTOCOL) {
      upstream.destroy();
      throw new LocalValidationError('Upstream did not negotiate agent-wire-v2');
    }
    const replayHeaders: Record<string, string> = {};
    for (const key of ['x-term2-event-format', 'x-term2-event-mode', 'x-term2-replay', 'x-term2-replay-from', 'x-term2-replay-to']) {
      if (typeof upstream.headers[key] === 'string') replayHeaders[key] = upstream.headers[key];
    }
    attachAbortCleanup(request.signal, () => {
      upstream.destroy();
    });
    const body = Readable.toWeb(upstream) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        ...replayHeaders,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
