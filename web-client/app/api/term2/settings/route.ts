import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return await forward(term2GatewayClient, {
      purpose: 'settings_read',
      method: 'GET',
      rpcPath: rpc.settings,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await readJsonBody(request);
    return await forward(term2GatewayClient, {
      purpose: 'settings_write',
      method: 'PUT',
      rpcPath: rpc.settings,
      body,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
