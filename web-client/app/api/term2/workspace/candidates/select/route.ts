import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, validateOpaqueId, LocalValidationError } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    if (typeof body.candidateId !== 'string' || typeof body.access !== 'string') {
      throw new LocalValidationError('Invalid select request');
    }
    return await forward(term2GatewayClient, {
      purpose: 'workspace_candidate_select',
      method: 'POST',
      rpcPath: rpc.candidatesSelect,
      body: {
        candidateId: validateOpaqueId(body.candidateId, 'candidate ID'),
        access: body.access,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
