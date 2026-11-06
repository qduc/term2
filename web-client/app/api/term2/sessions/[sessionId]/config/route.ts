import { TERM2_WIRE_PROTOCOL } from '@/lib/term2/types';
import { LOCAL_OWNER_USER_ID } from '@/lib/server/gateway-config.js';
import { NextResponse } from 'next/server';
import { term2GatewayClient } from '@/lib/server/term2-gateway-client.js';
import {
  errorResponse,
  readJsonBody,
  rpc,
  validateOpaqueId,
  LocalValidationError,
} from '@/lib/server/proxy';
import { resolveSessionWorkspace } from '@/lib/server/session-lookup';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId: rawSessionId } = await params;
    const sessionId = validateOpaqueId(rawSessionId, 'session ID');
    const resolved = await resolveSessionWorkspace(sessionId);
    if ('response' in resolved) return resolved.response;
    if (new URL(request.url).searchParams.get('format') !== TERM2_WIRE_PROTOCOL) throw new LocalValidationError('agent-wire-v2 negotiation required');
    const body = await readJsonBody(request);
    const discovery = Object.keys(body).length === 0;
    const allowedKeys = ['clientRequestId', 'expectedRevision', 'admission', 'modelSelection', 'reasoningEffort', 'mode'];
    if (!discovery) {
      if (Object.keys(body).some((key) => !allowedKeys.includes(key)) ||
          typeof body.clientRequestId !== 'string' || !body.clientRequestId ||
          typeof body.expectedRevision !== 'string' || !body.expectedRevision ||
          (body.admission !== undefined && body.admission !== 'idle') ||
          !['modelSelection', 'reasoningEffort', 'mode'].some(key => key in body))
        throw new LocalValidationError('Invalid keyed session configuration');
      if (body.modelSelection !== undefined) {
        const model = body.modelSelection as Record<string, unknown>;
        if (!model || typeof model !== 'object' || Array.isArray(model) ||
            Object.keys(model).some(key => !['provider', 'model'].includes(key)) ||
            typeof model.provider !== 'string' || !model.provider || typeof model.model !== 'string' || !model.model)
          throw new LocalValidationError('Invalid model selection');
      }
      if ((body.reasoningEffort !== undefined && (typeof body.reasoningEffort !== 'string' || !['default','none','minimal','low','medium','high','xhigh'].includes(body.reasoningEffort))) ||
          (body.mode !== undefined && (typeof body.mode !== 'string' || !['standard','bare','lite','plan','mentor','orchestrator'].includes(body.mode))))
        throw new LocalValidationError('Invalid session selection');
    }
    const response = await term2GatewayClient.request({
      userId: LOCAL_OWNER_USER_ID,
      purpose: 'session_update', method: 'POST', rpcPath: rpc.sessionConfig(sessionId),
      // session_update assertions bind only the session; the gateway checks its owner.
      sessionId, body,
      query: `?format=${TERM2_WIRE_PROTOCOL}`,
      preserveConfigureResult: !discovery,
    });
    return NextResponse.json(response.body ?? {}, { status: response.statusCode, headers: response.headers['x-term2-config-format'] === TERM2_WIRE_PROTOCOL ? { 'x-term2-config-format': TERM2_WIRE_PROTOCOL } : {} });
  } catch (error) {
    return errorResponse(error);
  }
}
