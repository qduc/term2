/** Public failures are deliberately redacted; never expose provider errors, paths or secrets. */
import type { ServerResult } from './server-contracts.js';
import type { WireCommandResult } from '../protocol/direct-wire.js';

export class ServerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable?: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServerHttpError';
  }
}
export function publicError(
  status: number,
  code: string,
  message: string,
  retryable?: boolean,
  details?: Record<string, unknown>,
): ServerResult {
  return {
    status,
    body: {
      error: { code, message, ...(retryable === undefined ? {} : { retryable }), ...(details ? { details } : {}) },
    },
  };
}
export function unavailable(feature: string): ServerResult {
  return publicError(503, 'gateway_unavailable', `${feature} is unavailable on the direct host`, true);
}
export function commandFailure(result: Extract<WireCommandResult, { ok: false }>): ServerResult {
  switch (result.code) {
    case 'invalid_command':
      return publicError(400, 'validation_error', 'command request is invalid');
    case 'stale_interaction':
      return publicError(409, 'stale_interaction', 'interaction is stale');
    case 'request_conflict':
      return publicError(409, 'idempotency_conflict', 'request conflicts with an existing admission');
    case 'too_late':
      return publicError(409, 'too_late', 'operation is too late for this turn');
    case 'not_found':
    case 'forbidden':
      return publicError(404, 'not_found', 'session not found');
    case 'not_admitting':
    case 'closed':
    case 'rejected':
      return publicError(409, 'session_not_admitting', 'session is not admitting');
    case 'storage_failure':
      return publicError(503, 'persistence_unavailable', 'session persistence unavailable', true);
    case 'replay_unavailable':
      return publicError(503, 'replay_unavailable', 'durable event replay is unavailable', true, {
        reloadRequired: true,
      });
    case 'unavailable':
      return unavailable('operation');
    default:
      return unavailable('session');
  }
}
export function mapServerError(error: unknown): ServerResult {
  if (error instanceof ServerHttpError)
    return publicError(error.status, error.code, error.message, error.retryable, error.details);
  // Host errors are structured by the direct host; don't leak their message.
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const name = error instanceof Error ? error.name : undefined;
  const surface = error && typeof error === 'object' && 'surface' in error ? error.surface : undefined;
  // Host/config errors are translated structurally: host transport must not import app composition.
  if (name === 'DirectHostConfigError') {
    if (code === 'validation_error' || code === 'oauth_invalid')
      return publicError(400, 'validation_error', 'request is invalid');
    if (code === 'invalid_cursor') return publicError(400, 'invalid_cursor', 'workspace cursor is invalid');
    if (code === 'settings_forbidden')
      return publicError(403, 'settings_forbidden', 'local owner authorization is required');
    if (code === 'model_catalog_unavailable')
      return publicError(503, 'model_catalog_unavailable', 'model catalog unavailable', true);
    if (code === 'model_unavailable') return publicError(422, 'validation_error', 'model is unavailable');
    if (code === 'workspace_grant_not_persisted' || code === 'configuration_invalid') return unavailable('gateway');
    if (code === 'workspace_grant_mismatch' && surface === 'authority') {
      const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
      const existingAccess =
        details && typeof details === 'object' && 'existingAccess' in details ? details.existingAccess : undefined;
      const grantStorage =
        details && typeof details === 'object' && 'grantStorage' in details ? details.grantStorage : undefined;
      if (
        (existingAccess === 'read' || existingAccess === 'read_write') &&
        (grantStorage === 'persisted' || grantStorage === 'static' || grantStorage === 'memory')
      ) {
        const change =
          grantStorage === 'persisted'
            ? 'To change access, the operator must stop the server, back up direct-workspace-grants.json in its effective state directory, remove only this root’s grant record, restart, and select the root again. Old sessions will no longer be accessible through that grant.'
            : grantStorage === 'static'
            ? 'This is a startup-supplied grant, not an editable persisted grant. Ask the operator to review the startup configuration; deleting persisted records cannot change it.'
            : 'This grant is in memory only. The operator must restart the host and select the root again; old sessions will lose their grant.';
        return publicError(
          403,
          'workspace_forbidden',
          `This root is already granted with ${existingAccess} access. Select that access to reuse it. ${change} See docs/contracts/14-agent-wire-v2-server.md, “Same-root access conflict”.`,
          false,
          { existingAccess, grantStorage },
        );
      }
    }
    if (
      surface === 'candidate' &&
      code !== 'candidate_not_found' &&
      code !== 'candidate_expired' &&
      code !== 'candidate_registry_full'
    )
      return code === 'workspace_owner_mismatch' || code === 'workspace_path_escape'
        ? publicError(403, 'workspace_forbidden', 'workspace access denied')
        : publicError(422, 'validation_error', 'workspace candidate is unavailable');
    if (surface === 'authority') return publicError(403, 'workspace_forbidden', 'workspace access denied');
  }
  if (code === 'settings_conflict') {
    const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
    return publicError(
      409,
      'settings_conflict',
      'settings changed; reload before retrying',
      false,
      details && typeof details === 'object'
        ? {
            ...('currentRevision' in details ? { currentRevision: details.currentRevision } : {}),
            ...('projection' in details ? { projection: details.projection } : {}),
          }
        : undefined,
    );
  }
  if (code === 'settings_not_allowed') return publicError(403, 'settings_forbidden', 'settings change is not allowed');
  if (code === 'not_persisted' || code === 'settings_unavailable')
    return publicError(503, 'settings_unavailable', 'settings unavailable', true);
  if (code === 'candidate_not_found' || code === 'candidate_expired')
    return publicError(404, 'not_found', 'workspace candidate not found');
  if (name === 'WorkspaceAdmissionError') {
    if (code === 'workspace_session_exists')
      return publicError(409, 'session_busy', 'a session is already active for this workspace');
    return publicError(403, 'workspace_forbidden', 'workspace access denied');
  }
  if (
    code === 'workspace_not_found' ||
    code === 'workspace_disabled' ||
    code === 'workspace_boundary_unverified' ||
    code === 'ssh_disabled'
  )
    return publicError(403, 'workspace_forbidden', 'workspace access denied');
  if (code === 'workspace_owner_mismatch' || code === 'workspace_path_escape' || code === 'write_not_allowed')
    return publicError(403, 'workspace_forbidden', 'workspace access denied');
  if (code === 'candidate_registry_full')
    return publicError(429, 'candidate_registry_full', 'workspace candidate capacity is full', true);
  if (
    code === 'workspace_root_unavailable' ||
    code === 'workspace_root_not_canonical' ||
    code === 'workspace_not_readable' ||
    code === 'workspace_not_directory'
  )
    return publicError(422, 'validation_error', 'workspace candidate is unavailable');
  if (code === 'workspace_session_exists')
    return publicError(409, 'session_busy', 'a session is already active for this workspace');
  if (code === 'not_found' || code === 'forbidden' || code === 'owner_mismatch')
    return publicError(404, 'not_found', 'session not found');
  if (code === 'replay_unavailable')
    return publicError(503, 'replay_unavailable', 'durable event replay is unavailable', true, {
      reloadRequired: true,
    });
  if (code === 'cursor_invalid') return publicError(400, 'invalid_cursor', 'session cursor is invalid');
  if (code === 'invalid_command') return publicError(400, 'validation_error', 'command request is invalid');
  if (code === 'cursor_compacted')
    return publicError(410, 'cursor_compacted', 'event replay requires a session reload', true, {
      reloadRequired: true,
    });
  if (code === 'request_conflict')
    return publicError(409, 'idempotency_conflict', 'request conflicts with an existing admission');
  return unavailable('gateway');
}
