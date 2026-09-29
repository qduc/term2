import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, validateOpaqueId } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: rawProvider } = await params;
    const provider = validateOpaqueId(rawProvider, 'provider');
    await readJsonBody(request);
    return await forward(term2GatewayClient, {
      purpose: 'oauth_login',
      method: 'POST',
      rpcPath: rpc.oauthLogin(provider),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
