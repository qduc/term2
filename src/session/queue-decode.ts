/** Durable queue shapes shared by log decoding and live admission validation. */
import { z } from 'zod';
import type { ContentPart } from '../model/index.js';
import type { DirectOrigin } from './facade-types.js';
import { parseDirectOrigin, directOriginKey } from './origin.js';
import type { DirectQueueFact } from './queue-types.js';

const id = z.string().min(1);
const originSchema = z.unknown().refine((value) => {
  try {
    parseDirectOrigin(value);
    return true;
  } catch {
    return false;
  }
}, 'invalid direct origin');
export const directContentSchema = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), mediaType: id, data: id, detail: z.string().optional() }),
  ]),
);
const content = directContentSchema.refine(
  (parts) => parts.some((part) => part.type === 'image' || part.text.trim().length > 0),
  'empty input',
);
const unique = (values: string[]) => new Set(values).size === values.length;
const ids = z.array(id).refine(unique, 'duplicate message IDs');
const nonemptyIds = z.array(id).min(1).refine(unique, 'duplicate message IDs');
const delivery = z.enum(['steer', 'follow_up', 'reject_if_busy']);
const admission = z.object({
  kind: z.enum(['started', 'queued', 'steering']),
  clientRequestId: id,
  messageId: id,
  turnId: id.optional(),
});
const record = z.object({
  request: z.object({
    clientRequestId: id,
    content,
    delivery,
    origin: originSchema.optional(),
    humanInputAt: id.optional(),
  }),
  messageId: id,
  receivedAt: id.optional(),
  content,
  admission,
  stage: z.enum(['queued', 'pending_steer']),
  turnId: id.optional(),
});
const schemas = {
  queue_submitted: z.object({ type: z.literal('queue_submitted'), record }),
  queue_edited: z.object({ type: z.literal('queue_edited'), messageId: id, content }),
  queue_retracted: z.object({ type: z.literal('queue_retracted'), messageId: id }),
  queue_discarded: z.object({ type: z.literal('queue_discarded'), messageIds: nonemptyIds }),
  queue_started: z.object({
    type: z.literal('queue_started'),
    messageId: id,
    turnId: id,
    rolloverCommandId: id.optional(),
  }),
  queue_steered: z.object({ type: z.literal('queue_steered'), messageIds: nonemptyIds, turnId: id }),
  queue_cancelling: z.object({
    type: z.literal('queue_cancelling'),
    turnId: id,
    cancelledMessageIds: ids,
    retainedMessageIds: ids,
    preservePendingSteers: z.boolean().optional(),
  }),
  queue_settled: z.object({
    type: z.literal('queue_settled'),
    turnId: id,
    outcome: z.enum(['completed', 'cancelled', 'failed', 'interrupted']),
    preservePendingSteers: z.boolean().optional(),
  }),
  queue_resumed: z.object({ type: z.literal('queue_resumed') }),
  queue_recovered: z.object({ type: z.literal('queue_recovered') }),
};

/** Recognize only real queue vocabulary; unknown queue-prefixed data still fails. */
export function isDirectQueueFactType(type: string): boolean {
  return Object.hasOwn(schemas, type);
}

/** Validate recorded bytes without normalizing or stripping their persisted values. */
export function parseDirectQueueFact(raw: unknown): DirectQueueFact {
  const value = z.object({ type: z.string() }).parse(raw);
  const schema = schemas[value.type as keyof typeof schemas];
  if (!schema) throw new Error(`Unknown queue fact ${value.type}`);
  schema.parse(raw);
  const fact = raw as DirectQueueFact;
  if (fact.type === 'queue_submitted') {
    const { record: item } = fact;
    if (
      item.messageId !== item.admission.messageId ||
      item.request.clientRequestId !== item.admission.clientRequestId ||
      directQueueContentKey(item.content) !== directQueueContentKey(item.request.content)
    )
      throw new Error('Queue admission/payload correlation mismatch');
    if (item.stage === 'pending_steer') {
      if (
        item.admission.kind !== 'steering' ||
        item.request.delivery !== 'steer' ||
        !item.turnId ||
        item.turnId !== item.admission.turnId
      )
        throw new Error('Invalid pending steer admission');
    } else if (
      item.admission.kind === 'steering' ||
      (item.admission.kind === 'started' && !item.admission.turnId) ||
      (item.turnId !== undefined && item.turnId !== item.admission.turnId)
    ) {
      throw new Error('Invalid queued/start admission');
    }
  }
  return fact;
}

/** Validate the authoritative flat origin, including human/automatic/relay identity. */
export function validDirectQueueOrigin(origin: unknown): boolean {
  if (origin === undefined) return true;
  try {
    parseDirectOrigin(origin);
    return true;
  } catch {
    return false;
  }
}

/** Stable original-origin fingerprint; no authority is packed into an opaque id. */
export function directQueueOriginKey(origin: DirectOrigin | undefined): string {
  return JSON.stringify(directOriginKey(origin));
}

/** Compare content fields independent of object property insertion order. */
export function directQueueContentKey(content: readonly ContentPart[]): string {
  return JSON.stringify(
    content.map((part) =>
      part.type === 'text' ? ['text', part.text] : ['image', part.mediaType, part.data, part.detail ?? null],
    ),
  );
}
