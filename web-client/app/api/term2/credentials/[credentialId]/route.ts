import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import { errorResponse, forward, readJsonBody, rpc, validateOpaqueId, LocalValidationError } from '@/lib/server/proxy';
import { assertLocalStateChangingRequest } from '@/lib/server/request-guards';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ credentialId: string }> }) {
  try {
    const { credentialId: rawId } = await params;
    const credentialId = validateOpaqueId(rawId, 'credential ID');
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 1 || typeof body.value !== 'string') {
      throw new LocalValidationError('Invalid credential request');
    }
    return await forward(term2GatewayClient, {
      purpose: 'credential_write',
      method: 'POST',
      rpcPath: rpc.credential(credentialId),
      body: { value: body.value },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ credentialId: string }> }) {
  try {
    const { credentialId: rawId } = await params;
    const credentialId = validateOpaqueId(rawId, 'credential ID');
    assertLocalStateChangingRequest(request);
    return await forward(term2GatewayClient, {
      purpose: 'credential_delete',
      method: 'DELETE',
      rpcPath: rpc.credential(credentialId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
