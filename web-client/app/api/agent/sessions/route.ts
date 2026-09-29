import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import {
  buildQuery,
  errorResponse,
  forward,
  parsePage,
  readJsonBody,
  rpc,
  validateOpaqueId,
  LocalValidationError,
} from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const page = parsePage(request);
    return await forward(term2GatewayClient, {
      purpose: 'session_list',
      method: 'GET',
      rpcPath: rpc.sessions,
      query: buildQuery(page),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 1 || typeof body.workspaceId !== 'string') {
      throw new LocalValidationError('Invalid session request');
    }
    return await forward(term2GatewayClient, {
      purpose: 'session_create',
      method: 'POST',
      rpcPath: rpc.sessions,
      workspaceId: validateOpaqueId(body.workspaceId, 'workspace ID'),
      body: { workspaceId: body.workspaceId },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
