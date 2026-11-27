import { Readable } from 'node:stream';
import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { LOCAL_OWNER_USER_ID } from '@/lib/server/gateway-config.js';
import { errorResponse, rpc, validateOpaqueId, LocalValidationError } from '@/lib/server/proxy';
import { attachAbortCleanup } from '@/lib/server/request-guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const params = new URLSearchParams();
    const rawWorkspaceId = url.searchParams.get('workspaceId');
    if (rawWorkspaceId !== null && rawWorkspaceId !== '') {
      params.set('workspaceId', validateOpaqueId(rawWorkspaceId, 'workspace ID'));
    }
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null && rawLimit !== '') {
      if (!/^\d{1,4}$/.test(rawLimit)) throw new LocalValidationError('Invalid limit');
      const limit = Number.parseInt(rawLimit, 10);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new LocalValidationError('Invalid limit');
      }
      params.set('limit', String(limit));
    }
    const query = params.size > 0 ? `?${params.toString()}` : '';

    const upstream = await term2GatewayClient.stream({
      userId: LOCAL_OWNER_USER_ID,
      purpose: 'session_list_events',
      rpcPath: rpc.sessionListEvents,
      query,
      signal: request.signal,
    });
    const extraHeaders: Record<string, string> = {};
    for (const key of ['x-term2-client-api-version', 'x-term2-daemon-id']) {
      if (typeof upstream.headers[key] === 'string') extraHeaders[key] = upstream.headers[key];
    }
    attachAbortCleanup(request.signal, () => {
      upstream.destroy();
    });
    const body = Readable.toWeb(upstream) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        ...extraHeaders,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
