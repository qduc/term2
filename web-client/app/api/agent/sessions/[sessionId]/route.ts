import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, rpc } from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    // Public GET is translated to the gateway's POST-only control RPC.
    return await forward(term2GatewayClient, {
      purpose: 'session_read',
      method: 'POST',
      rpcPath: rpc.session(sessionId),
      workspaceId: resolved.workspaceId,
      sessionId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

import { forward } from '@/lib/server/proxy';
