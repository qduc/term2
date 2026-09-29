import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, rpc, validateOpaqueId } from '@/lib/server/proxy';
import { assertLocalStateChangingRequest } from '@/lib/server/request-guards';

export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ provider: string; accountId: string }> },
) {
  try {
    const { provider: rawProvider, accountId: rawAccountId } = await params;
    const provider = validateOpaqueId(rawProvider, 'provider');
    const accountId = validateOpaqueId(rawAccountId, 'account ID');
    assertLocalStateChangingRequest(request);
    return await forward(term2GatewayClient, {
      purpose: 'oauth_delete',
      method: 'DELETE',
      rpcPath: rpc.oauthAccount(provider, accountId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
