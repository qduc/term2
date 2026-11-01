import { NextResponse } from 'next/server';
import { TERM2_WIRE_PROTOCOL } from '@/lib/term2/types';
import { LOCAL_OWNER_USER_ID } from '@/lib/server/gateway-config.js';
import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, rpc, LocalValidationError } from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

/** Separate accepted-cut hydration, not an SSE snapshot or v1 transcript fallback. */
export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    const format = new URL(request.url).searchParams.get('format');
    const header = request.headers.get('x-term2-event-format');
    if (format !== TERM2_WIRE_PROTOCOL || (header !== null && header !== format)) throw new LocalValidationError('agent-wire-v2 hydration negotiation required');
    // Public GET is translated to the gateway's POST-only control RPC.
    const response = await term2GatewayClient.request({
      userId: LOCAL_OWNER_USER_ID, purpose: 'session_read', method: 'POST', rpcPath: rpc.session(sessionId),
      workspaceId: resolved.workspaceId, sessionId, query: `?format=${TERM2_WIRE_PROTOCOL}`,
    });
    if (response.headers['x-term2-hydration-format'] !== TERM2_WIRE_PROTOCOL || response.headers['x-term2-hydration'] !== 'current-accepted') throw new LocalValidationError('Upstream native hydration was not negotiated');
    return NextResponse.json(response.body, { status: response.statusCode, headers: {
      'x-term2-hydration-format': TERM2_WIRE_PROTOCOL, 'x-term2-hydration': 'current-accepted',
    } });
  } catch (error) { return errorResponse(error); }
}
