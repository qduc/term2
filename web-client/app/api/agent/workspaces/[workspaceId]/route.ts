import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, rpc, validateOpaqueId } from '@/lib/server/proxy';
import { assertLocalStateChangingRequest } from '@/lib/server/request-guards';

export const runtime = 'nodejs';

/** Removes a saved folder. Its chats no longer open; the gateway closes live ones. */
export async function DELETE(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId: rawId } = await params;
    const workspaceId = validateOpaqueId(rawId, 'workspace ID');
    assertLocalStateChangingRequest(request);
    return await forward(term2GatewayClient, {
      purpose: 'workspace_remove',
      method: 'DELETE',
      rpcPath: rpc.workspace(workspaceId),
      workspaceId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
