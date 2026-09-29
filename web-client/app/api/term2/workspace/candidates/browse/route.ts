import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, validateOpaqueId, LocalValidationError } from '@/lib/server/proxy';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    if (typeof body.candidateId !== 'string') throw new LocalValidationError('Invalid browse request');
    const upstream: Record<string, unknown> = { candidateId: validateOpaqueId(body.candidateId, 'candidate ID') };
    if (body.child !== undefined) {
      if (typeof body.child !== 'string') throw new LocalValidationError('Invalid browse request');
      upstream.child = body.child;
    }
    return await forward(term2GatewayClient, {
      purpose: 'workspace_candidate_browse',
      method: 'POST',
      rpcPath: rpc.candidatesBrowse,
      body: upstream,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
