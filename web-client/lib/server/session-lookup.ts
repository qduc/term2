import { NextResponse } from 'next/server';
import { term2GatewayClient } from './term2-gateway-client.js';
import { workspaceForSession } from './session-bindings.js';
import { validateOpaqueId } from './proxy';

/**
 * Resolve the workspace binding a session-scoped assertion needs. Returns a
 * 404 response when the gateway does not know the session.
 */
export async function resolveSessionWorkspace(
  sessionId: string,
): Promise<{ workspaceId: string } | { response: NextResponse }> {
  validateOpaqueId(sessionId, 'session ID');
  const workspaceId = await workspaceForSession(term2GatewayClient, sessionId);
  if (!workspaceId) {
    return {
      response: NextResponse.json({ error: { code: 'not_found', message: 'Session not found' } }, { status: 404 }),
    };
  }
  return { workspaceId };
}
