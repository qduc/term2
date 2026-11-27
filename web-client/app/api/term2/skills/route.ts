import type { NextRequest } from 'next/server';
import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, rpc, validateOpaqueId } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const raw = request.nextUrl.searchParams.get('workspaceId');
    const workspaceId = raw ? validateOpaqueId(raw, 'workspace ID') : undefined;
    return await forward(term2GatewayClient, {
      purpose: 'skills_list',
      method: 'GET',
      rpcPath: rpc.skills(workspaceId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
