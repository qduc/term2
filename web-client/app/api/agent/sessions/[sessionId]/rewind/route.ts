import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, LocalValidationError, readJsonBody, rpc, validateOpaqueId } from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const body = await readJsonBody(request);
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    if (typeof body.targetId !== 'string' || !body.targetId.trim() || body.targetId.length > 256) {
      throw new LocalValidationError('Invalid rewind target');
    }
    const upstreamBody: Record<string, unknown> = {
      targetId: body.targetId,
      clientRequestId: validateOpaqueId(body.clientRequestId, 'client request ID'),
    };
    if (typeof body.expectedRevision === 'string' && body.expectedRevision.length > 0) {
      upstreamBody.expectedRevision = body.expectedRevision;
    }
    return await forward(term2GatewayClient, {
      purpose: 'session_rewind',
      method: 'POST',
      rpcPath: rpc.rewind(sessionId),
      workspaceId: resolved.workspaceId,
      sessionId,
      body: upstreamBody,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
