import { Readable } from 'node:stream';
import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { LOCAL_OWNER_USER_ID } from '@/lib/server/gateway-config.js';
import { errorResponse, rpc, validateEventCursor } from '@/lib/server/proxy';
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
    let after = url.searchParams.get('after') ?? request.headers.get('last-event-id');
    after = validateEventCursor(after);
    const query = after ? `?after=${after}` : '';

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
    attachAbortCleanup(request.signal, () => {
      upstream.destroy();
    });
    const body = Readable.toWeb(upstream) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
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
