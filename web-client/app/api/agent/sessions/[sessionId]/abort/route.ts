import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc } from '@/lib/server/proxy';
import { validateAbortBody } from '@/lib/server/request-validation';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    const body = validateAbortBody(await readJsonBody(request));
    return await forward(term2GatewayClient, {
      purpose: 'abort',
      method: 'POST',
      rpcPath: rpc.abort(sessionId),
      workspaceId: resolved.workspaceId,
      sessionId,
      body,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
