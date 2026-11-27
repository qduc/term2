/**
 * Deterministic error mapping and strict parameter parsing for the Core Client API v1.0.
 */
import { DirectProtocolError } from '../../protocol/errors.js';
import type { WireCommandResult } from '../../protocol/wire.js';
import type { ClientApiError, ClientApiErrorCode } from '../../protocol/client-api/client-api-schema.js';

export class ClientApiRpcError extends Error {
  readonly code: ClientApiErrorCode;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ClientApiErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'ClientApiRpcError';
    this.code = code;
    this.retryable = options?.retryable;
    this.details = options?.details;
  }

  toWire(): ClientApiError {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryable !== undefined ? { retryable: this.retryable } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

function mapProtocolCode(code: string): ClientApiErrorCode {
  switch (code) {
    case 'unauthorized':
      return 'unauthorized';
    case 'forbidden':
      return 'forbidden';
    case 'not_found':
      return 'not_found';
    case 'stale_interaction':
      return 'stale_interaction';
    case 'stale_revision':
    case 'request_conflict':
      return 'stale_revision';
    case 'busy':
    case 'rejected':
      return 'busy';
    case 'replay_unavailable':
      return 'cursor_out_of_range';
    case 'unavailable':
      return 'unavailable';
    case 'closed':
      return 'closed';
    case 'invalid_command':
    case 'invalid_request':
      return 'invalid_request';
    default:
      return 'internal_error';
  }
}

function mapConfigErrorCode(code: unknown, status: unknown, surface: unknown): ClientApiErrorCode {
  if (code === 'stale_revision' || code === 'settings_conflict' || status === 409) return 'stale_revision';
  if (
    code === 'forbidden' ||
    code === 'workspace_forbidden' ||
    code === 'settings_forbidden' ||
    status === 403 ||
    surface === 'authority'
  ) {
    return 'forbidden';
  }
  if (code === 'not_found' || status === 404) return 'not_found';
  if (status === 400 || code === 'validation_error' || code === 'settings_not_allowed') return 'invalid_request';
  if (status === 503 || code === 'settings_unavailable' || code === 'not_persisted') return 'unavailable';
  return 'internal_error';
}

export function toClientApiError(error: unknown): ClientApiError {
  if (error instanceof ClientApiRpcError) return error.toWire();
  if (error instanceof DirectProtocolError) {
    const code = mapProtocolCode(error.code);
    return { code, message: error.message || code, retryable: code === 'busy' || code === 'unavailable' };
  }
  if (error instanceof Error) {
    const anyErr = error as { code?: unknown; status?: unknown; surface?: unknown; details?: unknown };
    if (error.name === 'DirectHostConfigError') {
      const code = mapConfigErrorCode(anyErr.code, anyErr.status, anyErr.surface);
      return {
        code,
        message: error.message || code,
        ...(anyErr.details && typeof anyErr.details === 'object'
          ? { details: anyErr.details as Record<string, unknown> }
          : {}),
      };
    }
    if (error.message.toLowerCase().includes('not found')) {
      return { code: 'not_found', message: error.message, retryable: false };
    }
    return { code: 'internal_error', message: error.message || 'Internal error.', retryable: false };
  }
  return { code: 'internal_error', message: 'Internal error.', retryable: false };
}

export function mapCommandFailure(result: Extract<WireCommandResult, { readonly ok: false }>): ClientApiRpcError {
  return new ClientApiRpcError(mapProtocolCode(result.code), result.message);
}

export function parseStrict<T>(
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
  input: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ClientApiRpcError('invalid_request', `Invalid ${label}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClientApiRpcError('invalid_request', `Invalid ${label}: expected object.`);
  }
  return value as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ClientApiRpcError('invalid_request', `Missing or invalid "${key}".`);
  }
  return value;
}
