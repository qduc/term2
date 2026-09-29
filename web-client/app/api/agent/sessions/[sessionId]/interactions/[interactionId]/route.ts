import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, LocalValidationError } from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; interactionId: string }> },
) {
  try {
    const { sessionId, interactionId } = await params;
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    const body = await readJsonBody(request);
    const allowedKeys = ['revision', 'answer', 'rejectionReason', 'approvalAnswer'];
    if (
      Object.keys(body).some((key) => !allowedKeys.includes(key)) ||
      !Number.isSafeInteger(body.revision) ||
      (body.revision as number) < 1 ||
      typeof body.answer !== 'string' ||
      body.answer.length > 100_000 ||
      hasControlCharacters(body.answer)
    ) {
      throw new LocalValidationError('Invalid interaction request');
    }
    const upstream: Record<string, unknown> = {
      revision: body.revision,
      answer: body.answer,
    };
    for (const field of ['rejectionReason', 'approvalAnswer'] as const) {
      if (body[field] !== undefined) {
        if (
          typeof body[field] !== 'string' ||
          (body[field] as string).length > 100_000 ||
          hasControlCharacters(body[field] as string)
        ) {
          throw new LocalValidationError('Invalid interaction request');
        }
        upstream[field] = body[field];
      }
    }
    return await forward(term2GatewayClient, {
      purpose: 'interaction_resolve',
      method: 'POST',
      rpcPath: rpc.interactions(sessionId, interactionId),
      workspaceId: resolved.workspaceId,
      sessionId,
      body: upstream,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
