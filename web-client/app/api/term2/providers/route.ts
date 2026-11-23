import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    return await forward(term2GatewayClient, {
      purpose: 'provider_write',
      method: 'POST',
      rpcPath: rpc.providers,
      body,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
