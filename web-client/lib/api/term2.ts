import { httpClient, HttpError, type HttpResponse } from '../http';
import {
  parsePendingInteraction,
  parseProjection,
  type AbortResult,
  type BrowseResult,
  type CandidateValidation,
  type InteractionResult,
  type InteractionResolveRequest,
  type MessageAdmission,
  type PendingInteraction,
  type SessionPage,
  type SessionProjection,
  type SessionConfigRecord,
  type SessionConfigUpdate,
  type SettingsProjection,
  type SettingsWriteResult,
  type ModelSummary,
  type Term2CommandId,
  type Term2CommandResult,
  TERM2_COMMAND_IDS,
  TERM2_COMMAND_OUTCOMES_BY_COMMAND,
  type WorkspacePage,
} from '../term2/types';

export class Term2ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'Term2ApiError';
  }
}

export class SettingsConflictError extends Term2ApiError {
  constructor(
    status: number,
    message: string,
    public readonly currentRevision: string,
    public readonly projection: SettingsProjection,
  ) {
    super(status, message, 'settings_conflict', { currentRevision, projection });
    this.name = 'SettingsConflictError';
  }
}

function apiError(error: unknown): Term2ApiError {
  if (error instanceof Term2ApiError) return error;
  if (error instanceof HttpError) {
    const data =
      error.data && typeof error.data === 'object' && !Array.isArray(error.data)
        ? (error.data as Record<string, unknown>)
        : undefined;
    const nested =
      data?.error && typeof data.error === 'object' && !Array.isArray(data.error)
        ? (data.error as Record<string, unknown>)
        : undefined;
    const flatCode = typeof data?.code === 'string' ? data.code : undefined;
    return new Term2ApiError(
      error.status,
      (typeof nested?.message === 'string' && nested.message) ||
        (typeof data?.message === 'string' && data.message) ||
        'Agent request failed',
      typeof nested?.code === 'string' ? nested.code : flatCode,
      nested?.details ?? (nested?.code ? nested : flatCode ? data : undefined),
    );
  }
  return new Term2ApiError(0, error instanceof Error ? error.message : 'Agent request failed');
}

async function getJson<T>(path: string, validator: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  try {
    const response = await httpClient.get<unknown>(path, { signal, skipAuth: true, skipRetry: true });
    return validator(response.data);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw apiError(error);
  }
}

async function postJson<T>(
  path: string,
  body: unknown,
  validator: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const response = await httpClient.post<unknown>(path, body, { signal, skipAuth: true, skipRetry: true });
    return validator(response.data);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw apiError(error);
  }
}

async function putJson<T>(
  path: string,
  body: unknown,
  validator: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const response = await httpClient.put<unknown>(path, body, { signal, skipAuth: true, skipRetry: true });
    return validator(response.data);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw apiError(error);
  }
}

async function deleteJson<T>(path: string, validator: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  try {
    const response = await httpClient.delete<unknown>(path, { signal, skipAuth: true, skipRetry: true });
    return validator(response.data);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw apiError(error);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Term2ApiError(503, 'Invalid agent response');
  return value as Record<string, unknown>;
}
function only(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Term2ApiError(503, 'Invalid agent response');
}
function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000\u0001-\u001f\u007f]/u.test(value))
    throw new Term2ApiError(503, 'Invalid agent response');
  return value;
}
function optionalText(value: unknown, max = 512): string | undefined {
  return value === undefined ? undefined : text(value, max);
}
export function validateCandidate(value: unknown): CandidateValidation {
  const input = object(value);
  only(input, ['candidateId', 'displayName', 'expiresAt', 'checks', 'valid', 'selectable', 'reasonCode', 'reason']);
  if (
    !Array.isArray(input.checks) ||
    typeof input.valid !== 'boolean' ||
    (input.selectable !== undefined && typeof input.selectable !== 'boolean') ||
    (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || Number(input.expiresAt) < 0))
  )
    throw new Term2ApiError(503, 'Invalid agent response');
  const candidateId = input.candidateId === undefined ? undefined : id(input.candidateId);
  return {
    ...(candidateId === undefined ? {} : { candidateId }),
    ...(input.displayName === undefined ? {} : { displayName: text(input.displayName, 200) }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt as number }),
    checks: input.checks.map((check) => {
      const item = object(check);
      only(item, ['name', 'status']);
      if (!['ok', 'error', 'pending', 'warning'].includes(String(item.status)))
        throw new Term2ApiError(503, 'Invalid agent response');
      return {
        name: text(item.name, 128),
        status: item.status as CandidateValidation['checks'][number]['status'],
      };
    }),
    valid: input.valid,
    // The gateway's validation contract predates the redundant `selectable`
    // field. A valid response with an opaque candidate id is selectable.
    selectable: input.selectable === undefined ? input.valid && candidateId !== undefined : input.selectable,
    ...(input.reasonCode === undefined ? {} : { reasonCode: text(input.reasonCode, 128) }),
    ...(input.reason === undefined ? {} : { reason: text(input.reason, 2_048) }),
  };
}

export function validateSelectedCandidate(value: unknown): {
  workspaceId: string;
  displayName: string;
  access: 'read' | 'read_write';
} {
  const input = object(value);
  only(input, ['workspaceId', 'displayName', 'access', 'binding']);
  const binding = input.binding === undefined ? undefined : object(input.binding);
  if (binding) only(binding, ['sessionId', 'ownerUserId', 'workspaceId', 'grantVersion', 'canonicalRoot', 'access']);
  const access = input.access ?? binding?.access;
  if (!['read', 'read_write'].includes(String(access))) throw new Term2ApiError(503, 'Invalid agent response');
  if (binding?.workspaceId !== undefined && binding.workspaceId !== input.workspaceId)
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    workspaceId: id(input.workspaceId),
    displayName: text(input.displayName, 200),
    access: access as 'read' | 'read_write',
  };
}
function validateBrowse(value: unknown): BrowseResult {
  const input = object(value);
  only(input, ['candidateId', 'entries', 'truncated']);
  if (!Array.isArray(input.entries) || typeof input.truncated !== 'boolean')
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    candidateId: id(input.candidateId),
    truncated: input.truncated,
    entries: input.entries.map((entry) => {
      const item = object(entry);
      only(item, ['name', 'type', 'selectable', 'rejectionReason', 'targetDisplay', 'childToken']);
      if (
        !['directory', 'file', 'symlink', 'other'].includes(String(item.type)) ||
        typeof item.selectable !== 'boolean'
      )
        throw new Term2ApiError(503, 'Invalid agent response');
      return {
        name: text(item.name, 256),
        type: item.type as BrowseResult['entries'][number]['type'],
        selectable: item.selectable,
        ...(optionalText(item.rejectionReason, 512) === undefined
          ? {}
          : { rejectionReason: optionalText(item.rejectionReason, 512) }),
        ...(optionalText(item.targetDisplay, 2_048) === undefined
          ? {}
          : { targetDisplay: optionalText(item.targetDisplay, 2_048) }),
        ...(item.childToken === undefined ? {} : { childToken: id(item.childToken) }),
      };
    }),
  };
}
function validateCredential(value: unknown): {
  status: 'saved' | 'deleted' | 'unchanged';
  configured: boolean;
  source?: string;
} {
  const input = object(value);
  only(input, ['status', 'configured', 'source']);
  if (!['saved', 'deleted', 'unchanged'].includes(String(input.status)) || typeof input.configured !== 'boolean')
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    status: input.status as 'saved' | 'deleted' | 'unchanged',
    configured: input.configured,
    ...(input.source === undefined ? {} : { source: text(input.source, 64) }),
  };
}
function validateOAuthResult(value: unknown): {
  status?: 'completed' | 'not_completed';
  configured?: boolean;
  ok?: boolean;
  isSelected?: boolean;
  isInUse?: boolean;
} {
  const input = object(value);
  only(input, ['status', 'configured', 'ok', 'isSelected', 'isInUse']);
  if (input.status !== undefined && !['completed', 'not_completed'].includes(String(input.status)))
    throw new Term2ApiError(503, 'Invalid agent response');
  for (const key of ['configured', 'ok', 'isSelected', 'isInUse'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw new Term2ApiError(503, 'Invalid agent response');
  return {
    ...(input.status === undefined ? {} : { status: input.status as 'completed' | 'not_completed' }),
    ...(input.configured === undefined ? {} : { configured: input.configured as boolean }),
    ...(input.ok === undefined ? {} : { ok: input.ok as boolean }),
    ...(input.configured === undefined ? {} : { configured: input.configured as boolean }),
    ...(input.isSelected === undefined ? {} : { isSelected: input.isSelected as boolean }),
    ...(input.isInUse === undefined ? {} : { isInUse: input.isInUse as boolean }),
  };
}
function validateModels(value: unknown): { models: ModelSummary[] } {
  const input = object(value);
  only(input, ['models']);
  if (!Array.isArray(input.models)) throw new Term2ApiError(503, 'Invalid agent response');
  return {
    models: input.models.map((model) => {
      const item = object(model);
      only(item, ['provider', 'id', 'name', 'default_reasoning_level', 'contextWindow']);
      if (
        item.contextWindow !== undefined &&
        (!Number.isSafeInteger(item.contextWindow) || (item.contextWindow as number) < 0)
      )
        throw new Term2ApiError(503, 'Invalid agent response');
      return {
        provider: text(item.provider, 256),
        id: text(item.id, 512),
        ...(item.name === undefined ? {} : { name: text(item.name, 512) }),
        ...(item.default_reasoning_level === undefined
          ? {}
          : { default_reasoning_level: text(item.default_reasoning_level, 128) }),
        ...(item.contextWindow === undefined ? {} : { contextWindow: item.contextWindow as number }),
      };
    }),
  };
}
function safeValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= 2_048);
}
function modelSelectionValue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  return Object.keys(selection).length === 2 &&
    typeof selection.model === 'string' && selection.model.trim().length > 0 &&
    typeof selection.provider === 'string' && selection.provider.trim().length > 0;
}
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === undefined) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => jsonValue(item, depth + 1));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 256 && entries.every(([key, item]) => key.length <= 256 && jsonValue(item, depth + 1));
  }
  return false;
}
export function validateSettings(value: unknown): SettingsProjection {
  const input = object(value);
  only(input, ['schemaVersion', 'revision', 'defaultsRevision', 'settings', 'session']);
  if (input.schemaVersion !== 1 || typeof input.revision !== 'string' || typeof input.defaultsRevision !== 'string')
    throw new Term2ApiError(503, 'Invalid agent response');
  const settings = object(input.settings);
  only(settings, ['safeDefaults', 'credentials', 'providers', 'oauthAccounts', 'safety']);
  if (
    !settings.safeDefaults ||
    typeof settings.safeDefaults !== 'object' ||
    Array.isArray(settings.safeDefaults) ||
    !settings.credentials ||
    typeof settings.credentials !== 'object' ||
    Array.isArray(settings.credentials) ||
    !Array.isArray(settings.providers) ||
    !settings.oauthAccounts ||
    typeof settings.oauthAccounts !== 'object' ||
    Array.isArray(settings.oauthAccounts)
  )
    throw new Term2ApiError(503, 'Invalid agent response');
  const safeDefaults: SettingsProjection['settings']['safeDefaults'] = {};
  for (const [key, raw] of Object.entries(settings.safeDefaults)) {
    const item = object(raw);
    only(item, ['value', 'source', 'scope', 'confirmRequired', 'persistable']);
    if (
      !['default', 'config', 'cli', 'environment', 'computed'].includes(String(item.source)) ||
      !['global', 'session'].includes(String(item.scope)) ||
      typeof item.confirmRequired !== 'boolean' ||
      typeof item.persistable !== 'boolean' ||
      (item.value !== undefined && !(key === 'agent.modelSelection' ? modelSelectionValue(item.value) : safeValue(item.value)))
    )
      throw new Term2ApiError(503, 'Invalid agent response');
    safeDefaults[key] = {
      ...(item.value === undefined ? {} : { value: item.value as never }),
      source: item.source as never,
      scope: item.scope as never,
      confirmRequired: item.confirmRequired,
      persistable: item.persistable,
    };
  }
  const credentials: SettingsProjection['settings']['credentials'] = {};
  for (const [key, raw] of Object.entries(settings.credentials)) {
    const item = object(raw);
    only(item, ['configured', 'required', 'source', 'writable']);
    if (
      typeof item.configured !== 'boolean' ||
      typeof item.required !== 'boolean' ||
      typeof item.writable !== 'boolean' ||
      !['setting', 'stored', 'environment', 'token-file', 'local', 'external', 'missing'].includes(String(item.source))
    )
      throw new Term2ApiError(503, 'Invalid agent response');
    credentials[key] = {
      configured: item.configured,
      required: item.required,
      writable: item.writable,
      source: item.source as never,
    };
  }
  const providers = settings.providers.map((raw) => {
    const item = object(raw);
    only(item, ['id', 'label', 'isCustom', 'active', 'disabled', 'credential', 'endpoint']);
    if (
      typeof item.active !== 'boolean' ||
      (item.isCustom !== undefined && typeof item.isCustom !== 'boolean') ||
      (item.disabled !== undefined && typeof item.disabled !== 'boolean')
    )
      throw new Term2ApiError(503, 'Invalid agent response');
    const credential = validateCredentialProjection(item.credential);
    return {
      id: text(item.id, 256),
      label: text(item.label, 256),
      active: item.active,
      credential,
      ...(item.isCustom === undefined ? {} : { isCustom: item.isCustom as boolean }),
      ...(item.disabled === undefined ? {} : { disabled: item.disabled as boolean }),
      ...(item.endpoint === undefined ? {} : { endpoint: validateEndpoint(item.endpoint) }),
    };
  });
  const oauthAccounts: SettingsProjection['settings']['oauthAccounts'] = {};
  for (const [provider, raw] of Object.entries(settings.oauthAccounts)) {
    if (!Array.isArray(raw)) throw new Term2ApiError(503, 'Invalid agent response');
    oauthAccounts[provider] = raw.map((account) => {
      const item = object(account);
      only(item, ['id', 'label', 'isSelected', 'isInUse']);
      if (typeof item.isSelected !== 'boolean' || typeof item.isInUse !== 'boolean')
        throw new Term2ApiError(503, 'Invalid agent response');
      return {
        id: id(item.id),
        label: text(item.label, 256),
        isSelected: item.isSelected,
        isInUse: item.isInUse,
      };
    });
  }
  const safety = object(settings.safety);
  only(safety, ['sandbox', 'approval', 'backgroundShell', 'workspaceAccess', 'network']);
  if (
    !['enabled', 'disabled', 'unavailable'].includes(String(safety.sandbox)) ||
    !['off', 'advisory', 'auto', 'unsafe-active', 'hidden'].includes(String(safety.approval)) ||
    safety.backgroundShell !== 'disabled-by-gateway' ||
    !['read', 'read_write'].includes(String(safety.workspaceAccess)) ||
    !['denied', 'configured', 'confirmation-required'].includes(String(safety.network))
  )
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    schemaVersion: input.schemaVersion as number,
    revision: text(input.revision, 256),
    defaultsRevision: text(input.defaultsRevision, 256),
    settings: {
      safeDefaults,
      credentials,
      providers,
      oauthAccounts,
      safety: safety as SettingsProjection['settings']['safety'],
    },
    ...(input.session === undefined ? {} : { session: validateSessionConfig(input.session) }),
  };
}
function validateCredentialProjection(value: unknown): SettingsProjection['settings']['credentials'][string] {
  const item = object(value);
  only(item, ['configured', 'required', 'source', 'writable']);
  if (
    typeof item.configured !== 'boolean' ||
    typeof item.required !== 'boolean' ||
    typeof item.writable !== 'boolean' ||
    !['setting', 'stored', 'environment', 'token-file', 'local', 'external', 'missing'].includes(String(item.source))
  )
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    configured: item.configured,
    required: item.required,
    writable: item.writable,
    source: item.source as never,
  };
}
function validateEndpoint(value: unknown): { host: string; path?: string } {
  const item = object(value);
  only(item, ['host', 'path']);
  return {
    host: text(item.host, 256),
    ...(item.path === undefined ? {} : { path: text(item.path, 512) }),
  };
}
function validateSessionConfig(value: unknown): SessionConfigRecord {
  const input = object(value);
  only(input, [
    'configRevision',
    'providerId',
    'modelId',
    'reasoningEffort',
    'mode',
    'defaultsRevision',
    'toolPolicy',
    'sessionId',
  ]);
  if (!['standard', 'lite', 'plan', 'mentor', 'orchestrator'].includes(String(input.mode)))
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    configRevision: text(input.configRevision, 256),
    providerId: text(input.providerId, 256),
    modelId: text(input.modelId, 512),
    reasoningEffort: text(input.reasoningEffort, 128),
    mode: input.mode as SessionConfigRecord['mode'],
    defaultsRevision: text(input.defaultsRevision, 256),
    ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy as SessionConfigRecord['toolPolicy'] }),
  };
}
function validateCredentialOperation(value: unknown): {
  status: 'saved' | 'deleted' | 'unchanged';
  configured: boolean;
  source?: string;
} {
  return validateCredential(value);
}
function validateSessionConfigResponse(value: unknown): SessionConfigRecord {
  return validateSessionConfig(object(value).config ?? value);
}
function validateAbsolutePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\u0000') ||
    !value.startsWith('/') ||
    value.split('/').includes('..')
  )
    throw new Term2ApiError(400, 'Workspace path must be absolute and traversal-free');
  return value;
}
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/u;
// Contract 13 §8: the bounded failure code a compaction reports when it did not compact.
const COMMAND_FAILURE_REASON = /^[a-z_]{1,64}$/u;
function id(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) throw new Term2ApiError(503, 'Invalid agent response');
  return value;
}
function page<T>(
  value: unknown,
  field: string,
  validate: (item: unknown) => T,
): { items: T[]; nextCursor: string | null } {
  const input = object(value);
  const items = input[field];
  if (!Array.isArray(items) || (input.nextCursor !== null && typeof input.nextCursor !== 'string'))
    throw new Term2ApiError(503, 'Invalid agent response');
  return { items: items.map(validate), nextCursor: input.nextCursor as string | null };
}
function validateWorkspace(value: unknown): WorkspacePage['workspaces'][number] {
  const input = object(value);
  if (
    Object.keys(input).some((key) => !['workspaceId', 'label', 'access'].includes(key)) ||
    !['read', 'read_write'].includes(String(input.access))
  )
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    workspaceId: id(input.workspaceId),
    label:
      typeof input.label === 'string'
        ? input.label.slice(0, 200)
        : (() => {
            throw new Term2ApiError(503, 'Invalid agent response');
          })(),
    access: input.access as 'read' | 'read_write',
  };
}
function validateSessionItem(value: unknown): SessionPage['sessions'][number] {
  const input = object(value);
  if (
    Object.keys(input).some(
      (key) => !['id', 'workspaceId', 'status', 'createdAt', 'updatedAt', 'latestSequence'].includes(key),
    )
  )
    throw new Term2ApiError(503, 'Invalid agent response');
  if (
    !['idle', 'running', 'awaiting_interaction', 'interrupted', 'closed'].includes(String(input.status)) ||
    typeof input.createdAt !== 'string' ||
    typeof input.updatedAt !== 'string' ||
    !Number.isSafeInteger(input.latestSequence) ||
    (input.latestSequence as number) < 0
  )
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    id: id(input.id),
    workspaceId: id(input.workspaceId),
    status: input.status as SessionPage['sessions'][number]['status'],
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    latestSequence: input.latestSequence as number,
  };
}
function validateWorkspacePage(value: unknown): WorkspacePage {
  const result = page<WorkspacePage['workspaces'][number]>(value, 'workspaces', validateWorkspace);
  return { workspaces: result.items, nextCursor: result.nextCursor };
}
function validateSessionPage(value: unknown): SessionPage {
  const result = page<SessionPage['sessions'][number]>(value, 'sessions', validateSessionItem);
  return { sessions: result.items, nextCursor: result.nextCursor };
}
function validateSession(value: unknown): SessionProjection {
  return parseProjection(object(value).session);
}
function validateMessage(value: unknown): MessageAdmission {
  const input = object(value);
  if (
    Object.keys(input).some(
      (key) => !['sessionId', 'clientRequestId', 'turnId', 'accepted', 'replayed'].includes(key),
    ) ||
    input.accepted !== true ||
    typeof input.replayed !== 'boolean'
  )
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    sessionId: id(input.sessionId),
    clientRequestId: id(input.clientRequestId),
    turnId: id(input.turnId),
    accepted: true,
    replayed: input.replayed,
  };
}
function validateAbort(value: unknown): AbortResult {
  const input = object(value);
  if (input.accepted === true && Object.keys(input).length === 3 && input.alreadySettled === undefined)
    return { sessionId: id(input.sessionId), turnId: id(input.turnId), accepted: true };
  if (input.accepted === false && input.alreadySettled === true && Object.keys(input).length === 4)
    return {
      sessionId: id(input.sessionId),
      turnId: id(input.turnId),
      accepted: false,
      alreadySettled: true,
    };
  throw new Term2ApiError(503, 'Invalid agent response');
}
function validateCommand(value: unknown): Term2CommandResult {
  const input = object(value);
  only(input, ['commandId', 'outcome', 'reason', 'turnId', 'tokensBefore', 'tokensAfter', 'replayed']);
  if (!(TERM2_COMMAND_IDS as readonly string[]).includes(String(input.commandId)))
    throw new Term2ApiError(503, 'Invalid agent response');
  // Contract 13 §8 pairs outcomes with commands, so the allowlist is per command.
  const allowedOutcomes = TERM2_COMMAND_OUTCOMES_BY_COMMAND[input.commandId as Term2CommandId] as readonly string[];
  if (!allowedOutcomes.includes(String(input.outcome))) throw new Term2ApiError(503, 'Invalid agent response');
  // Only an accepted retry names a turn; its content arrives on the event stream.
  if (input.outcome === 'accepted' ? input.turnId === undefined : input.turnId !== undefined)
    throw new Term2ApiError(503, 'Invalid agent response');
  // A failed compaction carries its bounded reason code; nothing else does.
  if (input.outcome === 'failed') {
    if (typeof input.reason !== 'string' || !COMMAND_FAILURE_REASON.test(input.reason))
      throw new Term2ApiError(503, 'Invalid agent response');
  } else if (input.reason !== undefined) throw new Term2ApiError(503, 'Invalid agent response');
  for (const field of ['tokensBefore', 'tokensAfter'])
    if (input[field] !== undefined && (!Number.isSafeInteger(input[field]) || (input[field] as number) < 0))
      throw new Term2ApiError(503, 'Invalid agent response');
  if (input.replayed !== undefined && typeof input.replayed !== 'boolean')
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    commandId: input.commandId as Term2CommandId,
    outcome: input.outcome as Term2CommandResult['outcome'],
    ...(input.reason === undefined ? {} : { reason: input.reason as string }),
    ...(input.turnId === undefined ? {} : { turnId: id(input.turnId) }),
    ...(input.tokensBefore === undefined ? {} : { tokensBefore: input.tokensBefore as number }),
    ...(input.tokensAfter === undefined ? {} : { tokensAfter: input.tokensAfter as number }),
    ...(input.replayed === undefined ? {} : { replayed: input.replayed as boolean }),
  };
}

function validateInteraction(value: unknown): InteractionResult {
  const input = object(value);
  if (input.accepted === false && Object.keys(input).length === 2)
    return { accepted: false, interaction: parsePendingInteraction(input.interaction) };
  if (input.accepted === true && Object.keys(input).length === 4)
    return {
      accepted: true,
      sessionId: id(input.sessionId),
      turnId: id(input.turnId),
      interactionId: id(input.interactionId),
    };
  throw new Term2ApiError(503, 'Invalid agent response');
}

function validateInteractionRequest(
  body: Omit<InteractionResolveRequest, 'interactionId'>,
): Omit<InteractionResolveRequest, 'interactionId'> {
  const input = body as unknown as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['revision', 'answer', 'rejectionReason', 'approvalAnswer'].includes(key)) ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 1 ||
    typeof input.answer !== 'string' ||
    input.answer.length > 16_384 ||
    /[\u0000-\u001f\u007f]/u.test(input.answer)
  )
    throw new Term2ApiError(400, 'Invalid interaction request');
  if (
    input.rejectionReason !== undefined &&
    (typeof input.rejectionReason !== 'string' ||
      input.rejectionReason.length > 2_048 ||
      /[\u0000-\u001f\u007f]/u.test(input.rejectionReason))
  )
    throw new Term2ApiError(400, 'Invalid interaction request');
  if (
    input.approvalAnswer !== undefined &&
    (typeof input.approvalAnswer !== 'string' ||
      input.approvalAnswer.length > 16_384 ||
      /[\u0000-\u001f\u007f]/u.test(input.approvalAnswer))
  )
    throw new Term2ApiError(400, 'Invalid interaction request');
  return {
    revision: input.revision as number,
    answer: input.answer,
    ...(input.rejectionReason === undefined ? {} : { rejectionReason: input.rejectionReason as string }),
    ...(input.approvalAnswer === undefined ? {} : { approvalAnswer: input.approvalAnswer as string }),
  };
}

const query = (limit: number, cursor?: string | null) =>
  `?limit=${encodeURIComponent(String(limit))}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

export const term2Client = {
  validateCandidate(absolutePath: string, signal?: AbortSignal) {
    return postJson(
      '/term2/workspace/candidates/validate',
      { absolutePath: validateAbsolutePath(absolutePath) },
      validateCandidate,
      signal,
    );
  },
  browseCandidate(candidateId: string, child?: string, signal?: AbortSignal) {
    const body = {
      candidateId: id(candidateId),
      ...(child === undefined ? {} : { child: id(child) }),
    };
    return postJson('/term2/workspace/candidates/browse', body, validateBrowse, signal);
  },
  selectCandidate(candidateId: string, access: 'read' | 'read_write', signal?: AbortSignal) {
    if (!['read', 'read_write'].includes(access)) throw new Term2ApiError(400, 'Invalid workspace access');
    return postJson(
      '/term2/workspace/candidates/select',
      { candidateId: id(candidateId), access },
      validateSelectedCandidate,
      signal,
    );
  },
  listModels(signal?: AbortSignal) {
    return getJson('/term2/models', validateModels, signal);
  },
  readSettings(signal?: AbortSignal) {
    return getJson('/term2/settings', validateSettings, signal);
  },
  async writeSettings(
    input: { expectedRevision: string; changes: Array<{ key: string; value: unknown }> },
    signal?: AbortSignal,
  ) {
    if (
      typeof input.expectedRevision !== 'string' ||
      input.expectedRevision.length === 0 ||
      !Array.isArray(input.changes)
    )
      throw new Term2ApiError(400, 'Invalid settings change');
    const changes = input.changes.map((change) => {
      if (!change || typeof change.key !== 'string' || change.key.length === 0 || !jsonValue(change.value))
        throw new Term2ApiError(400, 'Invalid settings change');
      return { key: change.key, value: change.value };
    });
    try {
      return await putJson(
        '/term2/settings',
        { expectedRevision: input.expectedRevision, changes },
        validateSettingsWrite,
        signal,
      );
    } catch (error) {
      if (error instanceof Term2ApiError && error.status === 409 && error.code === 'settings_conflict') {
        const details = (error.details && typeof error.details === 'object' ? error.details : {}) as Record<
          string,
          unknown
        >;
        const projection = details.projection;
        if (typeof details.currentRevision !== 'string' || projection === undefined)
          throw new Term2ApiError(503, 'Invalid settings conflict response');
        throw new SettingsConflictError(
          409,
          'Settings changed externally',
          details.currentRevision,
          validateSettings(projection),
        );
      }
      throw error;
    }
  },
  setCredential(credentialId: string, value: string, signal?: AbortSignal) {
    if (typeof value !== 'string' || value.length > 16_384 || /[\u0000\u007f]/u.test(value))
      throw new Term2ApiError(400, 'Invalid credential value');
    return postJson(
      `/term2/credentials/${encodeURIComponent(id(credentialId))}`,
      { value },
      validateCredentialOperation,
      signal,
    );
  },
  deleteCredential(credentialId: string, signal?: AbortSignal) {
    return deleteJson(
      `/term2/credentials/${encodeURIComponent(id(credentialId))}`,
      validateCredentialOperation,
      signal,
    );
  },
  oauthLogin(provider: string, signal?: AbortSignal) {
    return postJson(`/term2/oauth/${encodeURIComponent(id(provider))}/login`, {}, validateOAuthResult, signal);
  },
  oauthSelect(provider: string, accountId: string, signal?: AbortSignal) {
    return postJson(
      `/term2/oauth/${encodeURIComponent(id(provider))}/select`,
      { accountId: id(accountId) },
      validateOAuthResult,
      signal,
    );
  },
  oauthDelete(provider: string, accountId: string, signal?: AbortSignal) {
    return deleteJson(
      `/term2/oauth/${encodeURIComponent(id(provider))}/accounts/${encodeURIComponent(id(accountId))}`,
      validateOAuthResult,
      signal,
    );
  },
  updateSessionConfig(sessionId: string, update: SessionConfigUpdate, signal?: AbortSignal) {
    if (
      Object.keys(update).some((key) => !['model', 'reasoningEffort', 'mode'].includes(key)) ||
      Object.values(update).some((value) => typeof value !== 'string') ||
      (update.mode !== undefined && !['standard', 'lite', 'plan', 'mentor', 'orchestrator'].includes(update.mode))
    )
      throw new Term2ApiError(400, 'Invalid session config');
    return postJson(
      `/term2/sessions/${encodeURIComponent(id(sessionId))}/config`,
      update,
      validateSessionConfigResponse,
      signal,
    );
  },
  listWorkspaces(limit = 20, cursor?: string | null, signal?: AbortSignal) {
    return getJson(`/agent/workspaces${query(limit, cursor)}`, validateWorkspacePage, signal);
  },
  listSessions(limit = 20, cursor?: string | null, signal?: AbortSignal) {
    return getJson(`/agent/sessions${query(limit, cursor)}`, validateSessionPage, signal);
  },
  createSession(workspaceId: string, signal?: AbortSignal) {
    return postJson('/agent/sessions', { workspaceId }, validateSession, signal);
  },
  getSession(sessionId: string, signal?: AbortSignal) {
    return getJson(`/agent/sessions/${encodeURIComponent(sessionId)}`, validateSession, signal);
  },
  submitMessage(sessionId: string, text: string, clientRequestId: string, signal?: AbortSignal) {
    return postJson(
      `/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
      { text, clientRequestId },
      validateMessage,
      signal,
    );
  },
  commands(sessionId: string, commandId: Term2CommandId, clientRequestId: string, signal?: AbortSignal) {
    if (!(TERM2_COMMAND_IDS as readonly string[]).includes(commandId)) throw new Term2ApiError(400, 'Invalid command');
    if (typeof clientRequestId !== 'string' || !OPAQUE_ID.test(clientRequestId))
      throw new Term2ApiError(400, 'Invalid command request');
    return postJson(
      `/agent/sessions/${encodeURIComponent(sessionId)}/commands`,
      { commandId, clientRequestId },
      validateCommand,
      signal,
    );
  },
  abort(sessionId: string, turnId: string, signal?: AbortSignal) {
    return postJson(`/agent/sessions/${encodeURIComponent(sessionId)}/abort`, { turnId }, validateAbort, signal);
  },
  async resolveInteraction(
    sessionId: string,
    interactionId: string,
    body: Omit<InteractionResolveRequest, 'interactionId'>,
    signal?: AbortSignal,
  ) {
    return postJson(
      `/agent/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}`,
      validateInteractionRequest(body),
      validateInteraction,
      signal,
    );
  },
  async openEvents(sessionId: string, after: number, signal?: AbortSignal): Promise<HttpResponse<Response>> {
    try {
      return await httpClient.get<Response>(
        `/agent/sessions/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(String(after))}`,
        {
          signal,
          skipAuth: true,
          skipRetry: true,
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(after) },
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw apiError(error);
    }
  },
};

function validateSettingsWrite(value: unknown): SettingsWriteResult {
  const input = object(value);
  only(input, ['committed', 'revision', 'projection']);
  if (input.committed !== true || typeof input.revision !== 'string')
    throw new Term2ApiError(503, 'Invalid agent response');
  return {
    committed: true,
    revision: text(input.revision, 256),
    projection: validateSettings(input.projection),
  };
}

export { apiError };
