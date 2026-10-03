import { NextResponse } from 'next/server';
import { Term2GatewayError, OPAQUE_ID, type Term2GatewayClient } from './term2-gateway-client.js';
import { LOCAL_OWNER_USER_ID } from './gateway-config.js';
import { rememberSessionBindings } from './session-bindings.js';
import { assertLocalStateChangingRequest } from './request-guards';
import { RequestValidationError } from './request-validation';

export const rpc = {
  workspaces: '/private/agent/v1/workspaces',
  candidatesValidate: '/private/agent/v1/workspace/candidates/validate',
  candidatesBrowse: '/private/agent/v1/workspace/candidates/browse',
  candidatesSelect: '/private/agent/v1/workspace/candidates/select',
  models: '/private/agent/v1/models',
  settings: '/private/agent/v1/settings',
  sessions: '/private/agent/v1/sessions',
  session: (sessionId: string) => `/private/agent/v1/sessions/${sessionId}`,
  messages: (sessionId: string) => `/private/agent/v1/sessions/${sessionId}/messages`,
  commands: (sessionId: string) => `/private/agent/v1/sessions/${sessionId}/commands`,
  abort: (sessionId: string) => `/private/agent/v1/sessions/${sessionId}/abort`,
  interactions: (sessionId: string, interactionId: string) =>
    `/private/agent/v1/sessions/${sessionId}/interactions/${interactionId}`,
  sessionConfig: (sessionId: string) => `/private/agent/v1/sessions/${sessionId}/config`,
  credential: (credentialId: string) => `/private/agent/v1/credentials/${credentialId}`,
  oauthLogin: (provider: string) => `/private/agent/v1/oauth/${provider}/login`,
  oauthSelect: (provider: string) => `/private/agent/v1/oauth/${provider}/select`,
  oauthAccount: (provider: string, accountId: string) => `/private/agent/v1/oauth/${provider}/accounts/${accountId}`,
};

export class LocalValidationError extends RequestValidationError {
  code = 'validation_error';
  status = 400;
}

export function validateOpaqueId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new LocalValidationError(`Invalid ${name}`);
  }
  return value;
}

export function validateEventCursor(value: string | null): string | null {
  if (value === null || value === '') return null;
  if (!/^\d{1,15}$/.test(value)) throw new LocalValidationError('Invalid cursor');
  return value;
}

export function validatePageCursor(value: string | null): string | null {
  if (value === null || value === '') return null;
  // Session-index cursors are opaque base64url tokens. Keep validation local
  // and bounded without assuming anything about their decoded representation.
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new LocalValidationError('Invalid cursor');
  return value;
}

export function parsePage(request: Request): { limit: number; cursor: string | null } {
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? 50 : Number.parseInt(limitRaw, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new LocalValidationError('Invalid page size');
  }
  return { limit, cursor: validatePageCursor(url.searchParams.get('cursor')) };
}

export function buildQuery(page: { limit: number; cursor: string | null }): string {
  return page.cursor ? `?limit=${page.limit}&cursor=${page.cursor}` : `?limit=${page.limit}`;
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    assertLocalStateChangingRequest(request);
    const parsed = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LocalValidationError('Invalid request body');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestValidationError) throw error;
    throw new LocalValidationError('Invalid JSON body');
  }
}

/** Pass the gateway's JSON response through with its status code. */
export async function forward(
  client: Term2GatewayClient,
  args: {
    purpose: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    rpcPath: string;
    workspaceId?: string;
    sessionId?: string;
    body?: Record<string, unknown>;
    query?: string;
  },
): Promise<NextResponse> {
  const response = await client.request({
    userId: LOCAL_OWNER_USER_ID,
    ...args,
  });
  rememberSessionBindings(response.body);
  return NextResponse.json(response.body ?? {}, { status: response.statusCode });
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof RequestValidationError) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof Term2GatewayError) {
    const details = error.code === 'settings_conflict' && isPlainObject(error.details) ? { details: error.details } : {};
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          requestId: error.requestId,
          ...details,
        },
      },
      { status: error.statusCode },
    );
  }
  return NextResponse.json(
    { error: { code: 'gateway_unavailable', message: 'Agent gateway unavailable', retryable: true } },
    { status: 503 },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
