import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import {
  errorResponse,
  forward,
  readJsonBody,
  rpc,
  validateOpaqueId,
  LocalValidationError,
} from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId: rawSessionId } = await params;
    const sessionId = validateOpaqueId(rawSessionId, 'session ID');
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    const body = await readJsonBody(request);
    const allowedKeys = ['model', 'reasoningEffort', 'mode'];
    if (
      Object.keys(body).length === 0 ||
      Object.keys(body).some((key) => !allowedKeys.includes(key)) ||
      Object.values(body).some((value) => typeof value !== 'string')
    ) {
      throw new LocalValidationError('Invalid session config');
    }
    return await forward(term2GatewayClient, {
      purpose: 'session_update',
      method: 'POST',
      rpcPath: rpc.sessionConfig(sessionId),
      workspaceId: resolved.workspaceId,
      sessionId,
      body,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
