/** Gateway-compatible ingress validation, independent of all runtime/session persistence. */
import type { CommandBody, SessionUpdateBody } from './server-contracts.js';
import { ServerHttpError } from './server-errors.js';
import { webSettingValue } from '../config/settings/web-settings-policy.js';
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

export function isWorkspaceAccessBody(body: unknown): body is { access: 'read' | 'read_write' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return Object.keys(value).length === 1 && (value.access === 'read' || value.access === 'read_write');
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

/** The settings policy owns which value shapes a web write may carry. */
function isSafeSettingsValue(value: unknown): boolean {
  return webSettingValue(value) !== undefined;
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
      [
        'clientRequestId',
        'expectedRevision',
        'admission',
        'modelSelection',
        'reasoningEffort',
        'mode',
        'approvalMode',
      ].includes(key),
    ) &&
    keys.some((key) => ['modelSelection', 'reasoningEffort', 'mode', 'approvalMode'].includes(key)) &&
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
        ![
          'clientRequestId',
          'expectedRevision',
          'admission',
          'modelSelection',
          'reasoningEffort',
          'mode',
          'approvalMode',
        ].includes(key),
    ) ||
    typeof value.clientRequestId !== 'string' ||
    value.clientRequestId.length === 0 ||
    typeof value.expectedRevision !== 'string' ||
    value.expectedRevision.length === 0 ||
    (value.admission !== undefined && value.admission !== 'idle') ||
    (value.modelSelection === undefined &&
      value.reasoningEffort === undefined &&
      value.mode === undefined &&
      value.approvalMode === undefined)
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
  if (
    value.approvalMode !== undefined &&
    (typeof value.approvalMode !== 'string' || !['off', 'auto', 'unattended', 'always'].includes(value.approvalMode))
  )
    return false;
  return (
    value.mode === undefined || (typeof value.mode === 'string' && ['standard', 'bare', 'lite'].includes(value.mode))
  );
}

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export function isTurnBody(body: unknown): body is { turnId: string; discardQueue?: boolean; returnSteers?: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const v = body as Record<string, unknown>;
  if (!Object.keys(v).every((k) => k === 'turnId' || k === 'discardQueue' || k === 'returnSteers')) return false;
  if (!isOpaqueId(v.turnId)) return false;
  if (v.discardQueue !== undefined && typeof v.discardQueue !== 'boolean') return false;
  if (v.returnSteers !== undefined && typeof v.returnSteers !== 'boolean') return false;
  if (v.returnSteers === true && v.discardQueue !== false) return false;
  return true;
}

export function isCommandBody(body: unknown): body is CommandBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (
    !Object.keys(value).every((key) =>
      ['commandId', 'clientRequestId', 'admission', 'expectedRevision', 'executionId'].includes(key),
    )
  )
    return false;
  if (value.executionId !== undefined && (value.commandId !== 'retry-tool' || !isOpaqueId(value.executionId)))
    return false;
  return (
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

export function isProviderWriteBody(body: unknown): body is import('./server-contracts.js').ProviderWriteInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const v = body as Record<string, unknown>;
  if (v.action === 'toggle') {
    return (
      Object.keys(v).every((k) => ['action', 'id', 'disabled'].includes(k)) &&
      typeof v.id === 'string' &&
      v.id.length > 0 &&
      v.id.length <= 256 &&
      typeof v.disabled === 'boolean'
    );
  }
  if (v.action === 'save') {
    const validTypes = ['openai', 'openai-compatible', 'llama.cpp', 'anthropic', 'google', 'opencode'];
    return (
      Object.keys(v).every((k) => ['action', 'originalId', 'name', 'type', 'baseUrl', 'apiKey'].includes(k)) &&
      typeof v.name === 'string' &&
      v.name.trim().length > 0 &&
      v.name.length <= 256 &&
      typeof v.type === 'string' &&
      validTypes.includes(v.type) &&
      (v.originalId === undefined ||
        v.originalId === null ||
        (typeof v.originalId === 'string' && v.originalId.length <= 256)) &&
      (v.baseUrl === undefined || (typeof v.baseUrl === 'string' && v.baseUrl.length <= 2048)) &&
      (v.apiKey === undefined || (typeof v.apiKey === 'string' && v.apiKey.length <= 16_384))
    );
  }
  return false;
}

export function isRewindBody(
  body: unknown,
): body is { targetId: string; clientRequestId: string; expectedRevision?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const v = body as Record<string, unknown>;
  return (
    Object.keys(v).every((k) => ['targetId', 'clientRequestId', 'expectedRevision'].includes(k)) &&
    typeof v.targetId === 'string' &&
    v.targetId.length > 0 &&
    v.targetId.length <= 256 &&
    isOpaqueId(v.clientRequestId) &&
    (v.expectedRevision === undefined || (typeof v.expectedRevision === 'string' && v.expectedRevision.length > 0))
  );
}

export function isQueueBody(body: unknown): body is
  | {
      action: 'edit';
      messageId: string;
      text: string;
      attachments?: Array<{ type: 'image'; mediaType: string; data: string }>;
    }
  | { action: 'retract'; messageId: string }
  | { action: 'resume' }
  | { action: 'discard' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const v = body as Record<string, unknown>;
  if (v.action === 'resume' || v.action === 'discard') return Object.keys(v).length === 1;
  if (v.action === 'retract') {
    return Object.keys(v).every((k) => k === 'action' || k === 'messageId') && isOpaqueId(v.messageId);
  }
  if (v.action === 'edit') {
    const hasAttachments = v.attachments !== undefined;
    if (hasAttachments && !isImageAttachments(v.attachments)) return false;
    return (
      Object.keys(v).every((k) => ['action', 'messageId', 'text', 'attachments'].includes(k)) &&
      isOpaqueId(v.messageId) &&
      typeof v.text === 'string' &&
      (v.text.trim().length > 0 || hasAttachments) &&
      v.text.length <= 128_000
    );
  }
  return false;
}

export function isTaskControlBody(
  body: unknown,
): body is
  | { action: 'cancel' | 'check_in' | 'foreground' | 'background'; taskId: string }
  | { action: 'drain_notifications'; clientRequestId: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const v = body as Record<string, unknown>;
  if (v.action === 'drain_notifications') {
    return Object.keys(v).every((k) => k === 'action' || k === 'clientRequestId') && isOpaqueId(v.clientRequestId);
  }
  return (
    Object.keys(v).every((k) => k === 'action' || k === 'taskId') &&
    ['cancel', 'check_in', 'foreground', 'background'].includes(String(v.action)) &&
    typeof v.taskId === 'string' &&
    v.taskId.length > 0 &&
    v.taskId.length <= 256
  );
}

/**
 * A submitted message the route may turn into a `submit` command. Unknown keys,
 * an oversized body, a non-opaque id, a bad delivery or skill, or text with no
 * attachment are refused here so the route does not re-decide them. Non-direct
 * clients may attach only the images `isImageAttachments` already accepts.
 */
export function directMessage(
  body: unknown,
  direct: boolean,
): {
  text: string;
  clientRequestId: string;
  attachments?: unknown;
  delivery?: unknown;
  expectedSteerTurnId?: string;
  skill?: string;
} | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const allowed = ['text', 'clientRequestId', 'attachments', 'delivery', 'expectedSteerTurnId', 'skill'];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof value.text !== 'string' ||
    value.text.length > 128_000 ||
    !isOpaqueId(value.clientRequestId)
  )
    return null;
  if (!direct && value.attachments !== undefined && !isImageAttachments(value.attachments)) return null;
  if (
    value.delivery !== undefined &&
    (typeof value.delivery !== 'string' || !['auto', 'steer', 'follow_up', 'reject_if_busy'].includes(value.delivery))
  )
    return null;
  if (value.expectedSteerTurnId !== undefined && !isOpaqueId(value.expectedSteerTurnId)) return null;
  if (value.skill !== undefined && (typeof value.skill !== 'string' || !value.skill.trim() || value.skill.length > 128))
    return null;
  if (!value.text.length && (!Array.isArray(value.attachments) || !value.attachments.length)) return null;
  return {
    text: value.text,
    clientRequestId: value.clientRequestId,
    ...(value.attachments !== undefined ? { attachments: value.attachments } : {}),
    ...(value.delivery !== undefined ? { delivery: value.delivery } : {}),
    ...(typeof value.expectedSteerTurnId === 'string' ? { expectedSteerTurnId: value.expectedSteerTurnId } : {}),
    ...(typeof value.skill === 'string' ? { skill: value.skill.trim() } : {}),
  };
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function isImageAttachments(value: unknown): value is Array<{ type: 'image'; mediaType: string; data: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return false;
  return value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const v = item as Record<string, unknown>;
    return (
      Object.keys(v).every((k) => k === 'type' || k === 'mediaType' || k === 'data') &&
      v.type === 'image' &&
      typeof v.mediaType === 'string' &&
      IMAGE_MEDIA_TYPES.has(v.mediaType) &&
      typeof v.data === 'string' &&
      v.data.length > 0 &&
      v.data.length <= 7_000_000 &&
      /^[A-Za-z0-9+/=]+$/.test(v.data)
    );
  });
}

export function parseGoalBody(body: unknown): import('./server-contracts.js').ServerGoalAction | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const v = body as Record<string, unknown>;
  if (v.action === 'set') {
    if (
      typeof v.text !== 'string' ||
      !v.text.trim() ||
      v.text.length > 4_000 ||
      (v.successCriteria !== undefined && (typeof v.successCriteria !== 'string' || v.successCriteria.length > 4_000))
    )
      return null;
    return {
      action: 'set',
      text: v.text.trim(),
      ...(typeof v.successCriteria === 'string' && v.successCriteria.trim()
        ? { successCriteria: v.successCriteria.trim() }
        : {}),
    };
  }
  if (v.action === 'achieved' || v.action === 'abandon' || v.action === 'clear' || v.action === 'accept_proposal') {
    return { action: v.action };
  }
  return null;
}

export function parseHandoffBody(body: unknown): import('./server-contracts.js').ServerHandoffInput | null {
  if (body === null || body === undefined) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const v = body as Record<string, unknown>;
  if (!Object.keys(v).every((k) => k === 'message' || k === 'model')) return null;
  if (v.message !== undefined && (typeof v.message !== 'string' || v.message.length > 16_000)) return null;
  let model: { provider: string; model: string } | undefined;
  if (v.model !== undefined) {
    if (!v.model || typeof v.model !== 'object' || Array.isArray(v.model)) return null;
    const m = v.model as Record<string, unknown>;
    if (
      Object.keys(m).length !== 2 ||
      typeof m.provider !== 'string' ||
      !m.provider.trim() ||
      m.provider.length > 256 ||
      typeof m.model !== 'string' ||
      !m.model.trim() ||
      m.model.length > 256
    )
      return null;
    model = { provider: m.provider.trim(), model: m.model.trim() };
  }
  const message = typeof v.message === 'string' && v.message.trim() ? v.message.trim() : undefined;
  return { ...(message ? { message } : {}), ...(model ? { model } : {}) };
}
