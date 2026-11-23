import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, rpc } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return await forward(term2GatewayClient, {
      purpose: 'skills_list',
      method: 'GET',
      rpcPath: rpc.skills,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
