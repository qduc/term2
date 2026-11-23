import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, LocalValidationError, rpc } from '@/lib/server/proxy';
import { assertLocalStateChangingRequest } from '@/lib/server/request-guards';

export const runtime = 'nodejs';

const PROVIDER_ID = /^[A-Za-z0-9_.-]{1,256}$/u;

export async function DELETE(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  try {
    assertLocalStateChangingRequest(request);
    const { providerId } = await params;
    if (!PROVIDER_ID.test(providerId)) {
      throw new LocalValidationError('Invalid provider ID');
    }
    return await forward(term2GatewayClient, {
      purpose: 'provider_delete',
      method: 'DELETE',
      rpcPath: rpc.providerDelete(providerId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
