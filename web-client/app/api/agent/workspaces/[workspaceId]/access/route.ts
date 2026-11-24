import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, validateOpaqueId, LocalValidationError } from '@/lib/server/proxy';

export const runtime = 'nodejs';

/** Sets a saved folder's access. The gateway decides whether widening is allowed. */
export async function PUT(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId: rawId } = await params;
    const workspaceId = validateOpaqueId(rawId, 'workspace ID');
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 1 || (body.access !== 'read' && body.access !== 'read_write')) {
      throw new LocalValidationError('Invalid workspace access request');
    }
    return await forward(term2GatewayClient, {
      purpose: 'workspace_access_update',
      method: 'PUT',
      rpcPath: rpc.workspaceAccess(workspaceId),
      workspaceId,
      body: { access: body.access },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
