import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc } from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const body = await readJsonBody(request);
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    return await forward(term2GatewayClient, {
      purpose: 'session_goal',
      method: 'POST',
      rpcPath: rpc.goal(sessionId),
      workspaceId: resolved.workspaceId,
      sessionId,
      body,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
