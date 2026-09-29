import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, LocalValidationError } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    if (
      Object.keys(body).length !== 1 ||
      typeof body.absolutePath !== 'string' ||
      body.absolutePath.length === 0 ||
      body.absolutePath.length > 4096
    ) {
      throw new LocalValidationError('Invalid workspace candidate request');
    }
    return await forward(term2GatewayClient, {
      purpose: 'workspace_candidate_validate',
      method: 'POST',
      rpcPath: rpc.candidatesValidate,
      body: { absolutePath: body.absolutePath },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
