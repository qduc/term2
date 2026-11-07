/** Gateway-compatible ingress validation, independent of all runtime/session persistence. */
import type { CommandBody, SessionUpdateBody } from './server-contracts.js';
import { ServerHttpError } from './server-errors.js';
export function hasDeferredModelSelectionField(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body as Record<string, unknown>).some((key) => ['model', 'reasoningEffort', 'mode'].includes(key));
}

export function isSessionCreateBody(body: unknown, workspaceId: string | undefined, legacy = false): boolean {
  if (legacy && body === null) return true;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((key) => key !== 'workspaceId')) return false;
  const requested = (body as Record<string, unknown>).workspaceId;
  return typeof requested === 'string' && requested === workspaceId;
}

export function isWorkspaceCandidateValidateBody(body: unknown): body is { absolutePath: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    typeof (body as Record<string, unknown>).absolutePath === 'string'
  );
}

export function isWorkspaceCandidateBrowseBody(body: unknown): body is { candidateId: string; child?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => key === 'candidateId' || key === 'child') &&
    isOpaqueId(value.candidateId) &&
    (value.child === undefined || isOpaqueId(value.child))
  );
}

export function isWorkspaceCandidateSelectBody(body: unknown): body is {
  candidateId: string;
  access: 'read' | 'read_write';
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => key === 'candidateId' || key === 'access') &&
    isOpaqueId(value.candidateId) &&
    (value.access === 'read' || value.access === 'read_write')
  );
}

export function isSettingsWriteBody(
  body: unknown,
): body is { expectedRevision: string; changes: Array<{ key: string; value: unknown }> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (typeof value.expectedRevision !== 'string' || !Array.isArray(value.changes) || value.changes.length > 100)
    return false;
  return value.changes.every((change) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return false;
    const item = change as Record<string, unknown>;
    return (
      Object.keys(item).length === 2 &&
      typeof item.key === 'string' &&
      Object.prototype.hasOwnProperty.call(item, 'value') &&
      isSafeSettingsValue(item.value)
    );
  });
}

export function isPairingRegisterBody(body: unknown): body is { publicKeyPem: string; otp: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    typeof value.publicKeyPem === 'string' &&
    value.publicKeyPem.length > 0 &&
    value.publicKeyPem.length <= 16_384 &&
    typeof value.otp === 'string' &&
    /^\d{6}$/.test(value.otp)
  );
}

export function isSafeSettingsValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

export function isCredentialWriteBody(body: unknown): body is { value: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    typeof (body as Record<string, unknown>).value === 'string' &&
    ((body as Record<string, unknown>).value as string).length > 0
  );
}

export function isOAuthSelectBody(body: unknown): body is { accountId: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    isOpaqueId((body as Record<string, unknown>).accountId)
  );
}

/** Recognizes a selection patch missing admission identity; never supplies keys or accepts it for dispatch. */
export function requiresSessionUpdateKeys(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  return (
    keys.every((key) =>
      ['clientRequestId', 'expectedRevision', 'admission', 'modelSelection', 'reasoningEffort', 'mode'].includes(key),
    ) &&
    keys.some((key) => ['modelSelection', 'reasoningEffort', 'mode'].includes(key)) &&
    (!Object.prototype.hasOwnProperty.call(value, 'clientRequestId') ||
      !Object.prototype.hasOwnProperty.call(value, 'expectedRevision'))
  );
}

export function isSessionUpdateBody(body: unknown): body is SessionUpdateBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length === 0) return true; // Explicit read-only discovery.
  if (
    Object.keys(value).some(
      (key) =>
        !['clientRequestId', 'expectedRevision', 'admission', 'modelSelection', 'reasoningEffort', 'mode'].includes(
          key,
        ),
    ) ||
    typeof value.clientRequestId !== 'string' ||
    value.clientRequestId.length === 0 ||
    typeof value.expectedRevision !== 'string' ||
    value.expectedRevision.length === 0 ||
    (value.admission !== undefined && value.admission !== 'idle') ||
    (value.modelSelection === undefined && value.reasoningEffort === undefined && value.mode === undefined)
  )
    return false;
  if (value.modelSelection !== undefined) {
    const selection = value.modelSelection;
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return false;
    const pair = selection as Record<string, unknown>;
    if (
      Object.keys(pair).length !== 2 ||
      !['model', 'provider'].every(
        (key) => typeof pair[key] === 'string' && pair[key].length > 0 && pair[key].length <= 512,
      )
    )
      return false;
  }
  if (
    value.reasoningEffort !== undefined &&
    (typeof value.reasoningEffort !== 'string' ||
      !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value.reasoningEffort))
  )
    return false;
  return (
    value.mode === undefined || (typeof value.mode === 'string' && ['standard', 'bare', 'lite'].includes(value.mode))
  );
}

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export function hasAttachments(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body as Record<string, unknown>).some((key) =>
    ['images', 'attachments', 'attachmentIds'].includes(key),
  );
}

export function isTurnBody(body: unknown): body is { turnId: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    isOpaqueId((body as Record<string, unknown>).turnId)
  );
}

export function isCommandBody(body: unknown): body is CommandBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).every((key) =>
      ['commandId', 'clientRequestId', 'admission', 'expectedRevision'].includes(key),
    ) &&
    (value.admission === undefined || value.admission === 'idle') &&
    (value.expectedRevision === undefined ||
      (typeof value.expectedRevision === 'string' && value.expectedRevision.length > 0)) &&
    typeof value.commandId === 'string' &&
    value.commandId.length > 0 &&
    value.commandId.length <= 256 &&
    isOpaqueId(value.clientRequestId)
  );
}

type InteractionResolveRequest = {
  revision: number;
  answer: string;
  rejectionReason?: string;
  approvalAnswer?: string;
};

export function isInteractionResolveRequest(body: unknown): body is InteractionResolveRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => ['revision', 'answer', 'rejectionReason', 'approvalAnswer'].includes(key)) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.answer === 'string' &&
    value.answer.length <= 16_384 &&
    (value.rejectionReason === undefined || typeof value.rejectionReason === 'string') &&
    (value.approvalAnswer === undefined || typeof value.approvalAnswer === 'string')
  );
}

export function parseQueryLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^[0-9]{1,3}$/.test(value)) throw new ServerHttpError(400, 'invalid_cursor', 'limit is invalid');
  return Number(value);
}

export function parseEventCursor(value: string | null): { value: number | null; error?: 'cursor_invalid' } {
  if (value === null) return { value: null };
  if (!/^(?:0|[1-9][0-9]{0,14})$/.test(value)) return { value: null, error: 'cursor_invalid' };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? { value: parsed } : { value: null, error: 'cursor_invalid' };
}
