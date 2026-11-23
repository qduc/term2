import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, rpc } from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    return await forward(term2GatewayClient, {
      purpose: 'session_rewind_targets',
      method: 'GET',
      rpcPath: rpc.rewindTargets(sessionId),
      workspaceId: resolved.workspaceId,
      sessionId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
