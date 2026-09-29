import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, validateOpaqueId, LocalValidationError } from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    const body = await readJsonBody(request);
    if (
      Object.keys(body).length !== 2 ||
      typeof body.text !== 'string' ||
      body.text.length === 0 ||
      body.text.length > 1_000_000 ||
      typeof body.clientRequestId !== 'string'
    ) {
      throw new LocalValidationError('Invalid message request');
    }
    return await forward(term2GatewayClient, {
      purpose: 'message_submit',
      method: 'POST',
      rpcPath: rpc.messages(sessionId),
      workspaceId: resolved.workspaceId,
      sessionId,
      body: { text: body.text, clientRequestId: validateOpaqueId(body.clientRequestId, 'client request ID') },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
