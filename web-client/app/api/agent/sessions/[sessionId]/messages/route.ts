import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, validateOpaqueId, LocalValidationError } from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const body = await readJsonBody(request);
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    const allowed = new Set(['text', 'clientRequestId', 'delivery', 'expectedSteerTurnId', 'skill', 'attachments']);
    if (
      Object.keys(body).some((key) => !allowed.has(key)) ||
      typeof body.text !== 'string' ||
      body.text.length > 128_000 ||
      typeof body.clientRequestId !== 'string'
    ) {
      throw new LocalValidationError('Invalid message request');
    }
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if (body.text.length === 0 && !hasAttachments) {
      throw new LocalValidationError('Invalid message request');
    }
    const upstreamBody: Record<string, unknown> = {
      text: body.text,
      clientRequestId: validateOpaqueId(body.clientRequestId, 'client request ID'),
    };
    if (body.delivery !== undefined) {
      if (typeof body.delivery !== 'string' || !['auto', 'steer', 'follow_up', 'reject_if_busy'].includes(body.delivery)) {
        throw new LocalValidationError('Invalid delivery mode');
      }
      upstreamBody.delivery = body.delivery;
    }
    if (body.expectedSteerTurnId !== undefined) {
      upstreamBody.expectedSteerTurnId = validateOpaqueId(body.expectedSteerTurnId, 'expected steer turn ID');
    }
    if (body.skill !== undefined) {
      if (typeof body.skill !== 'string' || !body.skill.trim() || body.skill.length > 128) {
        throw new LocalValidationError('Invalid skill');
      }
      upstreamBody.skill = body.skill.trim();
    }
    if (body.attachments !== undefined) {
      if (!Array.isArray(body.attachments) || body.attachments.length === 0 || body.attachments.length > 4) {
        throw new LocalValidationError('Invalid attachments');
      }
      upstreamBody.attachments = body.attachments;
    }
    return await forward(term2GatewayClient, {
      purpose: 'message_submit',
      method: 'POST',
      rpcPath: rpc.messages(sessionId),
      workspaceId: resolved.workspaceId,
      sessionId,
      body: upstreamBody,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
