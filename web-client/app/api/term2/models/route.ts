import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { buildQuery, errorResponse, forward, parsePage, rpc } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const page = parsePage(request);
    return await forward(term2GatewayClient, {
      purpose: 'model_list',
      method: 'GET',
      rpcPath: rpc.models,
      query: buildQuery(page),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
