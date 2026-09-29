export class RequestValidationError extends Error {
  code = 'validation_error';
  status = 400;
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/u;
const COMMAND_IDS = new Set(['compact', 'retry-tool', 'retry-turn']);

function opaqueId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) throw new RequestValidationError(`Invalid ${name}`);
  return value;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).length !== keys.length || Object.keys(body).some((key) => !keys.includes(key))) {
    throw new RequestValidationError('Invalid request body');
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new RequestValidationError(`Invalid ${name}`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw new RequestValidationError(`Invalid ${name}`);
    }
  }
  return value;
}

export function validateInteractionBody(body: Record<string, unknown>, interactionId: unknown) {
  opaqueId(interactionId, 'interaction ID');
  const allowedKeys = ['revision', 'answer', 'rejectionReason', 'approvalAnswer'] as const;
  if (Object.keys(body).some((key) => !allowedKeys.includes(key as (typeof allowedKeys)[number]))) {
    throw new RequestValidationError('Invalid interaction request');
  }
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) {
    throw new RequestValidationError('Invalid interaction request');
  }
  const upstream: Record<string, unknown> = { revision: body.revision, answer: text(body.answer, 'answer') };
  for (const field of ['rejectionReason', 'approvalAnswer'] as const) {
    if (body[field] !== undefined) upstream[field] = text(body[field], field);
  }
  return upstream;
}

export function validateAbortBody(body: Record<string, unknown>) {
  exactKeys(body, ['turnId']);
  return { turnId: opaqueId(body.turnId, 'turn ID') };
}

export function validateCommandBody(body: Record<string, unknown>) {
  exactKeys(body, ['commandId', 'clientRequestId']);
  if (typeof body.commandId !== 'string' || !COMMAND_IDS.has(body.commandId)) {
    throw new RequestValidationError('Invalid command ID');
  }
  return { commandId: body.commandId, clientRequestId: opaqueId(body.clientRequestId, 'client request ID') };
}
