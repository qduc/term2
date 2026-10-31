import type { Principal } from '../host/index.js';

/**
 * Failures from direct host/config operations.
 *
 * `surface` distinguishes candidate browsing from grant authority when the
 * gateway used two error types for one code and mapped them to different
 * statuses. `directHostConfigFailure` is the status map the server should use.
 * Details are secret-free; credential values never ride on an error.
 */
export type DirectHostConfigErrorCode =
  | 'invalid_cursor'
  | 'validation_error'
  | 'candidate_not_found'
  | 'candidate_expired'
  | 'candidate_registry_full'
  | 'workspace_not_found'
  | 'workspace_owner_mismatch'
  | 'workspace_disabled'
  | 'workspace_grant_mismatch'
  | 'workspace_authority_revoked'
  | 'workspace_root_unavailable'
  | 'workspace_root_not_canonical'
  | 'workspace_path_escape'
  | 'workspace_not_readable'
  | 'workspace_not_directory'
  | 'write_not_allowed'
  | 'workspace_grant_not_persisted'
  | 'settings_forbidden'
  | 'settings_conflict'
  | 'settings_not_allowed'
  | 'settings_unavailable'
  | 'not_persisted'
  | 'model_catalog_unavailable'
  | 'model_unavailable'
  | 'oauth_invalid'
  | 'pairing_required'
  | 'pairing_invalid'
  | 'pairing_unavailable'
  | 'pairing_not_allowed'
  | 'configuration_invalid';

export type DirectHostConfigSurface = 'candidate' | 'authority' | 'config' | 'pairing' | 'startup';

export class DirectHostConfigError extends Error {
  readonly code: DirectHostConfigErrorCode;
  readonly surface: DirectHostConfigSurface;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: DirectHostConfigErrorCode,
    surface: DirectHostConfigSurface,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.name = 'DirectHostConfigError';
    this.code = code;
    this.surface = surface;
    this.details = details;
  }
}

export function isDirectHostConfigError(error: unknown): error is DirectHostConfigError {
  return error instanceof DirectHostConfigError;
}

/** A principal is an id, never an implicit allow. `via: 'local'` grants nothing by itself. */
export function requirePrincipal(principal: Principal): string {
  if (
    !principal ||
    typeof principal.userId !== 'string' ||
    principal.userId.length === 0 ||
    principal.userId.includes('\0')
  ) {
    throw new DirectHostConfigError('validation_error', 'config');
  }
  return principal.userId;
}

export type DirectHostConfigFailure = {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
};

function failure(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: Readonly<Record<string, unknown>>,
): DirectHostConfigFailure {
  return details ? { status, code, message, retryable, details } : { status, code, message, retryable };
}

function conflictDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!details) return undefined;
  const currentRevision = details.currentRevision;
  const projection = details.projection;
  const picked: Record<string, unknown> = {};
  if (typeof currentRevision === 'string') picked.currentRevision = currentRevision;
  if (projection && typeof projection === 'object') picked.projection = projection;
  return picked;
}

/** Map a host/config failure to the gateway's public status, code and message. */
export function directHostConfigFailure(error: DirectHostConfigError): DirectHostConfigFailure {
  const code = error.code;
  if (code === 'invalid_cursor') return failure(400, 'invalid_cursor', 'workspace cursor is invalid', false);
  if (code === 'validation_error') return failure(400, 'validation_error', 'request is invalid', false);
  if (code === 'candidate_not_found' || code === 'candidate_expired') {
    return failure(404, 'not_found', 'workspace candidate not found', false);
  }
  if (code === 'candidate_registry_full') {
    return failure(429, 'candidate_registry_full', 'workspace candidate capacity is full', true);
  }
  if (code === 'settings_conflict') {
    return failure(
      409,
      'settings_conflict',
      'settings changed; reload before retrying',
      false,
      conflictDetails(error.details),
    );
  }
  if (code === 'settings_forbidden')
    return failure(403, 'settings_forbidden', 'local owner authorization is required', false);
  if (code === 'settings_not_allowed')
    return failure(403, 'settings_forbidden', 'settings change is not allowed', false);
  if (code === 'not_persisted') return failure(503, 'settings_unavailable', 'settings could not be saved', true);
  if (code === 'settings_unavailable') return failure(503, 'settings_unavailable', 'settings unavailable', true);
  if (code === 'model_catalog_unavailable')
    return failure(503, 'model_catalog_unavailable', 'model catalog unavailable', true);
  if (code === 'model_unavailable') return failure(422, 'validation_error', 'model is unavailable', false);
  if (code === 'oauth_invalid') return failure(400, 'validation_error', 'OAuth request is invalid', false);
  if (code === 'pairing_unavailable') return failure(503, 'pairing_unavailable', 'pairing is unavailable', true);
  if (code === 'pairing_invalid') return failure(401, 'pairing_invalid', 'pairing rejected', false);
  if (code === 'pairing_required' || code === 'pairing_not_allowed') {
    return failure(401, 'pairing_required', 'pairing rejected', false);
  }
  if (code === 'workspace_grant_not_persisted' || code === 'configuration_invalid') {
    return failure(503, 'gateway_unavailable', 'gateway unavailable', true);
  }
  if (error.surface === 'candidate') {
    if (code === 'workspace_owner_mismatch' || code === 'workspace_path_escape') {
      return failure(403, 'workspace_forbidden', 'workspace access denied', false);
    }
    return failure(422, 'validation_error', 'workspace candidate is unavailable', false);
  }
  return failure(403, 'workspace_forbidden', 'workspace access denied', false);
}
