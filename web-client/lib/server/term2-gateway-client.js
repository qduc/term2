import fs from 'fs';
import http from 'http';
import https from 'https';
import jwt from 'jsonwebtoken';
import { createHash, createPublicKey, randomUUID } from 'crypto';
import { getGatewayConfig } from './gateway-config.js';

export const ASSERTION_PURPOSES = Object.freeze([
  'workspace_list',
  'workspace_candidate_validate',
  'workspace_candidate_browse',
  'workspace_candidate_select',
  'model_list',
  'settings_read',
  'settings_write',
  'credential_write',
  'credential_delete',
  'oauth_login',
  'oauth_select',
  'oauth_delete',
  'session_update',
  'session_list',
  'session_create',
  'session_read',
  'message_submit',
  'interaction_resolve',
  'command_invoke',
  'abort',
  'events_connect',
]);

const PURPOSES = new Set(ASSERTION_PURPOSES);
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/u;
const INTERNAL_PREFIX = '/private/agent/v1/';
const SAFE_ERROR_CODES = new Set([
  'gateway_unavailable',
  'not_found',
  'workspace_forbidden',
  'validation_error',
  'model_selection_deferred',
  'model_unavailable',
  'queue_full',
  'session_not_admitting',
  'persistence_unavailable',
  'idempotency_conflict',
  'stale_interaction',
  'interaction_already_resolved',
  'interaction_not_resolvable',
  'cursor_compacted',
  'projection_too_large',
  'invalid_cursor',
  'protocol_conflict',
  'request_too_large',
  'attachments_not_enabled',
  'cursor_invalid',
  'unsupported_media_type',
  'candidate_expired',
  'candidate_not_found',
  'candidate_invalid',
  'workspace_owner_mismatch',
  'workspace_path_escape',
  'candidate_registry_full',
  'settings_conflict',
  'credential_invalid',
  'flow_in_progress',
  'model_catalog_unavailable',
  'settings_not_allowed',
  'settings_forbidden',
  'not_persisted',
  'settings_unavailable',
  'session_busy',
  'command_not_allowed',
  'compact_failed',
  'compact_interrupted',
  'compact_invalid_state',
  'retry_failed',
  'local_owner_required',
  'pairing_invalid',
  'pairing_required',
  'pairing_disabled',
]);

const SAFE_ERROR_MESSAGES = Object.freeze({
  gateway_unavailable: 'Agent gateway unavailable',
  not_found: 'Resource not found',
  workspace_forbidden: 'Workspace is not available',
  validation_error: 'Invalid request',
  model_selection_deferred: 'Model selection is not available',
  model_unavailable: 'Configured model is unavailable',
  queue_full: 'Session queue is full',
  session_not_admitting: 'Session is not accepting work',
  persistence_unavailable: 'Session persistence is unavailable',
  idempotency_conflict: 'Request conflicts with an earlier request',
  stale_interaction: 'Interaction is stale',
  interaction_already_resolved: 'Interaction is already resolved',
  interaction_not_resolvable: 'Interaction cannot be resolved',
  cursor_compacted: 'Event cursor requires reload',
  projection_too_large: 'Session projection is too large',
  invalid_cursor: 'Invalid cursor',
  protocol_conflict: 'Cursor values disagree',
  request_too_large: 'Request is too large',
  attachments_not_enabled: 'Attachments are not available',
  cursor_invalid: 'Invalid cursor',
  unsupported_media_type: 'Unsupported media type',
  candidate_expired: 'Workspace candidate has expired',
  candidate_not_found: 'Workspace candidate not found',
  candidate_invalid: 'Workspace candidate is invalid',
  workspace_owner_mismatch: 'Workspace access denied',
  workspace_path_escape: 'Workspace access denied',
  candidate_registry_full: 'Workspace candidate capacity is full',
  settings_conflict: 'Settings changed; reload and retry',
  credential_invalid: 'Credential is invalid',
  flow_in_progress: 'An authorization flow is already in progress',
  model_catalog_unavailable: 'Model catalog unavailable',
  settings_not_allowed: 'Settings change is not allowed',
  settings_forbidden: 'Settings change is not allowed',
  not_persisted: 'Settings could not be saved',
  settings_unavailable: 'Settings unavailable',
  session_busy: 'Session is busy',
  command_not_allowed: 'Command is not allowed',
  compact_failed: 'Context compaction failed',
  compact_interrupted: 'Context compaction was interrupted',
  compact_invalid_state: 'Context compaction state is invalid',
  retry_failed: 'Retry failed',
  local_owner_required: 'Local owner access is required',
  pairing_invalid:
    'OTP invalid/expired — read the current OTP from the gateway console and set TERM2_GATEWAY_PAIRING_OTP',
  pairing_required: 'Agent gateway pairing is required',
  pairing_disabled: 'Agent gateway pairing is unavailable',
});

export class Term2GatewayError extends Error {
  constructor(
    code,
    _message = 'Agent gateway unavailable',
    { statusCode = 503, retryable = true, requestId, details } = {},
  ) {
    const normalizedCode = code === 'settings_forbidden' ? 'settings_not_allowed' : code;
    const safeCode = SAFE_ERROR_CODES.has(normalizedCode) ? normalizedCode : 'gateway_unavailable';
    super(SAFE_ERROR_MESSAGES[safeCode]);
    this.name = 'Term2GatewayError';
    this.code = safeCode;
    this.statusCode =
      safeCode === 'settings_not_allowed' ? 400 : statusCode >= 400 && statusCode <= 599 ? statusCode : 503;
    this.retryable = Boolean(retryable);
    this.requestId = requestId;
    this.details = details;
  }
}

function assertPurpose(purpose) {
  if (!PURPOSES.has(purpose))
    throw new Term2GatewayError('validation_error', 'Invalid gateway operation', { statusCode: 400, retryable: false });
}

function assertOpaqueId(value, name) {
  if (value !== undefined && (typeof value !== 'string' || !OPAQUE_ID.test(value))) {
    throw new Term2GatewayError('validation_error', `Invalid ${name}`, { statusCode: 400, retryable: false });
  }
}

function readPrivateKey(filePath, readFile = fs.readFileSync) {
  if (!filePath) throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable');
  try {
    return readFile(filePath, 'utf8');
  } catch {
    throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable');
  }
}

/**
 * Create the per-request client assertion. Only the server-side local-owner
 * identity is accepted; browser input never reaches this function.
 */
export function createAgentAssertion({
  userId,
  purpose,
  workspaceId,
  sessionId,
  now = Math.floor(Date.now() / 1000),
  privateKey,
  issuer,
  audience,
  keyId,
  ttlSec,
  clockSkewSec,
} = {}) {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 256) {
    throw new Term2GatewayError('validation_error', 'Invalid authenticated principal', {
      statusCode: 400,
      retryable: false,
    });
  }
  assertPurpose(purpose);
  assertOpaqueId(workspaceId, 'workspace ID');
  assertOpaqueId(sessionId, 'session ID');
  const isList =
    purpose === 'workspace_list' ||
    purpose === 'workspace_candidate_validate' ||
    purpose === 'workspace_candidate_browse' ||
    purpose === 'workspace_candidate_select' ||
    purpose === 'session_list' ||
    purpose === 'model_list';
  const noWorkspace =
    isList ||
    [
      'settings_read',
      'settings_write',
      'credential_write',
      'credential_delete',
      'oauth_login',
      'oauth_select',
      'oauth_delete',
      'session_update',
    ].includes(purpose);
  if (noWorkspace && purpose !== 'session_update' && (workspaceId !== undefined || sessionId !== undefined)) {
    throw new Term2GatewayError('validation_error', 'Resource binding is not valid for this operation', {
      statusCode: 400,
      retryable: false,
    });
  }
  if (purpose === 'session_update' && workspaceId !== undefined) {
    throw new Term2GatewayError('validation_error', 'Workspace binding is not valid for session update', {
      statusCode: 400,
      retryable: false,
    });
  }
  if (!noWorkspace && typeof workspaceId !== 'string') {
    throw new Term2GatewayError('validation_error', 'Workspace binding is required', {
      statusCode: 400,
      retryable: false,
    });
  }
  if (purpose === 'session_update' && typeof sessionId !== 'string') {
    throw new Term2GatewayError('validation_error', 'Session binding is required', {
      statusCode: 400,
      retryable: false,
    });
  }
  if (purpose !== 'session_create' && !isList && !noWorkspace && typeof sessionId !== 'string') {
    throw new Term2GatewayError('validation_error', 'Session binding is required', {
      statusCode: 400,
      retryable: false,
    });
  }
  if (purpose === 'session_create' && sessionId !== undefined) {
    throw new Term2GatewayError('validation_error', 'Session ID is not valid for creation', {
      statusCode: 400,
      retryable: false,
    });
  }
  if (!privateKey) throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable');
  if (!issuer || !audience || !keyId) throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable');

  const claims = {
    iss: issuer,
    aud: audience,
    sub: userId,
    purpose,
    iat: now,
    nbf: now - Math.max(0, Math.min(clockSkewSec, 30)),
    exp: now + Math.max(1, Math.min(ttlSec, 60)),
    jti: randomUUID(),
    ver: 1,
  };
  if (!isList && !noWorkspace && workspaceId !== undefined) claims.workspaceId = workspaceId;
  if (purpose === 'session_update' && sessionId !== undefined) claims.sessionId = sessionId;
  if (!isList && !noWorkspace && sessionId !== undefined) claims.sessionId = sessionId;

  try {
    return jwt.sign(claims, privateKey, { algorithm: 'RS256', keyid: keyId });
  } catch {
    throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable');
  }
}

function normalizeGatewayError(statusCode, body, requestId) {
  const source = body && typeof body === 'object' ? body.error : null;
  const sourceCode = source?.code === 'settings_forbidden' ? 'settings_not_allowed' : source?.code;
  const hasSafeCode = typeof sourceCode === 'string' && SAFE_ERROR_CODES.has(sourceCode);
  const code = hasSafeCode ? sourceCode : 'gateway_unavailable';
  const retryable = typeof source?.retryable === 'boolean' ? source.retryable : statusCode >= 500;
  const safeStatus =
    code === 'settings_not_allowed' ? 400 : hasSafeCode && statusCode >= 400 && statusCode <= 599 ? statusCode : 503;
  return new Term2GatewayError(code, undefined, {
    statusCode: safeStatus,
    retryable,
    requestId,
    details:
      hasSafeCode && code === 'settings_conflict' && source?.details && typeof source.details === 'object'
        ? source.details
        : undefined,
  });
}

function safeRpcPath(rpcPath) {
  if (
    typeof rpcPath !== 'string' ||
    !rpcPath.startsWith(INTERNAL_PREFIX) ||
    rpcPath.includes('..') ||
    rpcPath.includes('?') ||
    rpcPath.includes('#')
  ) {
    throw new Term2GatewayError('validation_error', 'Invalid gateway operation', { statusCode: 400, retryable: false });
  }
  return rpcPath;
}

function validatePairingResponse(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.paired !== true ||
    typeof value.kid !== 'string' ||
    value.kid.length === 0 ||
    typeof value.fingerprint !== 'string' ||
    value.fingerprint.length === 0
  ) {
    throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable');
  }
  return value;
}

export class Term2GatewayClient {
  constructor({
    gatewayConfig = getGatewayConfig(),
    requestImpl,
    readFile = fs.readFileSync,
    derivePublicKey = (privateKey) => createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
  } = {}) {
    this.gatewayConfig = gatewayConfig;
    this.requestImpl = requestImpl;
    this.readFile = readFile;
    this.derivePublicKey = derivePublicKey;
    this.pairingComplete = false;
  }

  #networkMode() {
    return this.gatewayConfig.gatewayPort !== undefined && this.gatewayConfig.gatewayPort !== null;
  }

  issueAssertion(fields) {
    const privateKey = fields?.privateKey || readPrivateKey(this.gatewayConfig.privateKeyPath, this.readFile);
    return createAgentAssertion({
      ...fields,
      privateKey,
      issuer: this.gatewayConfig.issuer,
      audience: this.gatewayConfig.audience,
      keyId: this.#assertionKeyId(privateKey),
      ttlSec: this.gatewayConfig.assertionTtlSec,
      clockSkewSec: this.gatewayConfig.clockSkewSec,
    });
  }

  /**
   * When OTP pairing is enabled, the gateway stores the client's public key under its
   * sha256(SPKI DER) fingerprint kid, so assertions must be signed with that same kid.
   * Otherwise use the configured keyId for the pre-paired path.
   */
  #assertionKeyId(privateKey) {
    if (!this.gatewayConfig.pairingEnabled) return this.gatewayConfig.keyId;
    try {
      const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
      return createHash('sha256').update(der).digest('hex');
    } catch {
      return this.gatewayConfig.keyId;
    }
  }

  #requestOptions({ method, rpcPath, assertion, body, correlationId, query = '' }) {
    if (
      typeof query !== 'string' ||
      query.length > 1024 ||
      query.includes('#') ||
      query.includes('..') ||
      (query && !query.startsWith('?'))
    ) {
      throw new Term2GatewayError('validation_error', 'Invalid gateway operation', {
        statusCode: 400,
        retryable: false,
      });
    }
    const serialized = body === undefined ? null : JSON.stringify(body);
    const transport = this.#networkMode()
      ? { host: this.gatewayConfig.gatewayHost || '127.0.0.1', port: this.gatewayConfig.gatewayPort }
      : { socketPath: this.gatewayConfig.socketPath };
    return {
      ...transport,
      path: `${safeRpcPath(rpcPath)}${query}`,
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(serialized ? { 'content-length': Buffer.byteLength(serialized) } : {}),
        // This is the sole internal assertion header, never copied from the browser.
        ...(assertion ? { 'x-term2-assertion': assertion } : {}),
        'x-correlation-id': correlationId,
      },
    };
  }

  #assertEnabled() {
    if (
      !this.gatewayConfig.enabled ||
      this.gatewayConfig.sshEnabled ||
      this.gatewayConfig.allowUnsandboxed ||
      this.gatewayConfig.autoApprove
    ) {
      throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable');
    }
    if (this.#networkMode()) {
      const port = this.gatewayConfig.gatewayPort;
      const host = this.gatewayConfig.gatewayHost;
      const requireClientCert = this.gatewayConfig.tlsRequireClientCert !== false;
      const hasClientCert =
        typeof this.gatewayConfig.tlsCertPath === 'string' && this.gatewayConfig.tlsCertPath.length > 0;
      const hasClientKey =
        typeof this.gatewayConfig.tlsKeyPath === 'string' && this.gatewayConfig.tlsKeyPath.length > 0;
      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        (host !== undefined && (typeof host !== 'string' || host.length === 0)) ||
        hasClientCert !== hasClientKey ||
        (requireClientCert && (!hasClientCert || !hasClientKey))
      ) {
        throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable');
      }
      return;
    }
    if (!this.gatewayConfig.socketPath) throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable');
  }

  async pair() {
    if (!this.gatewayConfig.pairingEnabled) return { paired: false };
    this.#assertEnabled();
    const otp = this.gatewayConfig.pairingOtp;
    if (typeof otp !== 'string' || !/^\d{6}$/u.test(otp)) {
      throw new Term2GatewayError('pairing_invalid', undefined, { statusCode: 401, retryable: false });
    }
    let publicKeyPem;
    let privateKey;
    try {
      privateKey = readPrivateKey(this.gatewayConfig.privateKeyPath, this.readFile);
      publicKeyPem = this.derivePublicKey(privateKey);
    } catch {
      throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { retryable: false });
    }
    if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) {
      throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { retryable: false });
    }
    const correlationId = randomUUID();
    const body = { publicKeyPem, otp };
    const options = this.#requestOptions({
      method: 'POST',
      rpcPath: '/private/agent/v1/pairing/register',
      body,
      correlationId,
    });
    const response = await this.#send(options, body, { correlationId, stream: false });
    const result = validatePairingResponse(response.body);
    const expectedKid = this.#assertionKeyId(privateKey);
    if (result.kid !== expectedKid) {
      throw new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { retryable: false });
    }
    this.pairingComplete = true;
    return result;
  }

  async #retryAfterPairing(operation) {
    try {
      return await operation();
    } catch (error) {
      if (
        this.gatewayConfig.pairingEnabled &&
        !this.pairingComplete &&
        error instanceof Term2GatewayError &&
        error.code === 'pairing_required'
      ) {
        await this.pair();
        return operation();
      }
      throw error;
    }
  }

  async #requestOnce({
    userId,
    purpose,
    workspaceId,
    sessionId,
    method = 'GET',
    rpcPath,
    body,
    query = '',
    correlationId = randomUUID(),
  } = {}) {
    this.#assertEnabled();
    assertPurpose(purpose);
    assertOpaqueId(workspaceId, 'workspace ID');
    assertOpaqueId(sessionId, 'session ID');
    const assertion = this.issueAssertion({ userId, purpose, workspaceId, sessionId });
    // The private control server is POST-only. Keep the public session-read
    // endpoint GET, but never send session_read upstream as GET.
    const upstreamMethod = purpose === 'session_read' ? 'POST' : method;
    const options = this.#requestOptions({ method: upstreamMethod, rpcPath, query, assertion, body, correlationId });
    return this.#send(options, body, { correlationId, stream: false });
  }

  async request(args = {}) {
    return this.#retryAfterPairing(() => this.#requestOnce(args));
  }

  async #streamOnce({
    userId,
    purpose,
    workspaceId,
    sessionId,
    rpcPath,
    query = '',
    correlationId = randomUUID(),
    signal,
  } = {}) {
    this.#assertEnabled();
    assertPurpose(purpose);
    if (purpose !== 'events_connect')
      throw new Term2GatewayError('validation_error', 'Invalid streaming operation', {
        statusCode: 400,
        retryable: false,
      });
    assertOpaqueId(workspaceId, 'workspace ID');
    assertOpaqueId(sessionId, 'session ID');
    if (typeof query !== 'string' || !/^$|\?after=\d{1,15}$/u.test(query))
      throw new Term2GatewayError('validation_error', 'Invalid gateway operation', {
        statusCode: 400,
        retryable: false,
      });
    const assertion = this.issueAssertion({ userId, purpose, workspaceId, sessionId });
    const options = this.#requestOptions({ method: 'GET', rpcPath, query, assertion, correlationId });
    return this.#send(options, null, { correlationId, stream: true, signal });
  }

  async stream(args = {}) {
    return this.#retryAfterPairing(() => this.#streamOnce(args));
  }

  #send(options, body, { correlationId, stream, signal }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutMs = stream ? this.gatewayConfig.streamTimeoutMs : this.gatewayConfig.requestTimeoutMs;
      let timer;
      let abortHandler;
      const cleanupAbortListener = () => {
        if (abortHandler) {
          signal.removeEventListener('abort', abortHandler);
          abortHandler = undefined;
        }
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanupAbortListener();
        const safeError =
          error instanceof Term2GatewayError
            ? error
            : new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { requestId: correlationId });
        reject(safeError);
      };
      let req;
      try {
        const network = this.#networkMode();
        const requestOptions = network
          ? {
              ...options,
              cert: this.gatewayConfig.tlsCertPath ? this.readFile(this.gatewayConfig.tlsCertPath) : undefined,
              key: this.gatewayConfig.tlsKeyPath ? this.readFile(this.gatewayConfig.tlsKeyPath) : undefined,
              ...(this.gatewayConfig.tlsCaPath ? { ca: this.readFile(this.gatewayConfig.tlsCaPath) } : {}),
              rejectUnauthorized: true,
              servername: this.gatewayConfig.gatewayHost || '127.0.0.1',
            }
          : options;
        const requestImpl = this.requestImpl || (network ? https.request : http.request);
        req = requestImpl(requestOptions, (response) => {
          if (stream && response.statusCode >= 200 && response.statusCode < 300) {
            settled = true;
            if (timer) clearTimeout(timer);
            cleanupAbortListener();
            resolve(response);
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > this.gatewayConfig.maxResponseBytes) {
              response.destroy();
              fail(
                new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { requestId: correlationId }),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            let parsed = null;
            try {
              parsed = Buffer.concat(chunks).toString('utf8')
                ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
                : null;
            } catch {
              /* safe generic mapping */
            }
            if (response.statusCode >= 200 && response.statusCode < 300) {
              settled = true;
              if (timer) clearTimeout(timer);
              cleanupAbortListener();
              resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
            } else {
              fail(normalizeGatewayError(response.statusCode, parsed, correlationId));
            }
          });
          response.on('error', () =>
            fail(
              new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { requestId: correlationId }),
            ),
          );
        });
        req.on('error', () =>
          fail(new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { requestId: correlationId })),
        );
        if (signal) {
          abortHandler = () => {
            req.destroy();
            fail(new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { requestId: correlationId }));
          };
          signal.addEventListener('abort', abortHandler, { once: true });
          if (signal.aborted) abortHandler();
        }
        if (settled) return;
        timer = setTimeout(() => {
          req.destroy();
          fail(new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { requestId: correlationId }));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        if (body !== null && body !== undefined) req.write(JSON.stringify(body));
        req.end();
      } catch {
        fail(new Term2GatewayError('gateway_unavailable', 'Agent gateway unavailable', { requestId: correlationId }));
      }
    });
  }
}

export const term2GatewayClient = new Term2GatewayClient();
export { OPAQUE_ID };
