import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, rpc, validateOpaqueId } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId: rawId } = await params;
    const workspaceId = validateOpaqueId(rawId, 'workspace ID');
    return await forward(term2GatewayClient, {
      purpose: 'workspace_files',
      rpcPath: rpc.workspaceFiles(workspaceId),
      workspaceId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
