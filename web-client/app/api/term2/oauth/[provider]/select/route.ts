import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, validateOpaqueId, LocalValidationError } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: rawProvider } = await params;
    const provider = validateOpaqueId(rawProvider, 'provider');
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 1 || typeof body.accountId !== 'string') {
      throw new LocalValidationError('Invalid OAuth selection');
    }
    return await forward(term2GatewayClient, {
      purpose: 'oauth_select',
      method: 'POST',
      rpcPath: rpc.oauthSelect(provider),
      body: { accountId: validateOpaqueId(body.accountId, 'account ID') },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
