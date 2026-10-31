/** Durable planning notices, delivered only by the Session's atomic silent admission. */
import { z } from 'zod';
import type { TurnId } from '../engine/index.js';
import type { DirectTaskId, DirectTaskState } from './direct-background-types.js';
import type { DirectBackgroundCheckIn } from './direct-background-check-ins.js';

export type DirectBackgroundNotice = {
  readonly id: string;
  readonly kind: 'completion' | 'control' | 'check_in';
  readonly taskIds: readonly DirectTaskId[];
  /** Session-produced planning input, not a human message or an authority grant. */
  readonly text: string;
};
export type DirectNoticeDelivery = {
  readonly clientRequestId: string;
  readonly turnId: TurnId;
  readonly notificationIds: readonly string[];
};
export type DirectNotificationFact =
  | { readonly type: 'background_notice_enqueued'; readonly notice: DirectBackgroundNotice }
  | ({ readonly type: 'background_notices_delivered' } & DirectNoticeDelivery);
export type DirectNotificationState = {
  readonly notices: readonly DirectBackgroundNotice[];
  readonly deliveries: readonly DirectNoticeDelivery[];
};
export type DirectNotificationDrainResult =
  | { readonly kind: 'started' | 'duplicate'; readonly turnId: TurnId; readonly notificationIds: readonly string[] }
  | { readonly kind: 'empty' | 'busy' }
  | { readonly kind: 'not_admitting'; readonly reason: string };

const id = z.string().min(1);
const ids = z
  .array(id)
  .min(1)
  .refine((values) => new Set(values).size === values.length);
const noticeSchema = z
  .object({ id, kind: z.enum(['completion', 'control', 'check_in']), taskIds: ids, text: id })
  .strict();
const schemas = {
  background_notice_enqueued: z
    .object({ type: z.literal('background_notice_enqueued'), notice: noticeSchema })
    .strict(),
  background_notices_delivered: z
    .object({ type: z.literal('background_notices_delivered'), clientRequestId: id, turnId: id, notificationIds: ids })
    .strict(),
};

/** Native decoder hook; parsing never strips persisted planning text or identity. */
export function isDirectNotificationFactType(type: string): type is DirectNotificationFact['type'] {
  return Object.hasOwn(schemas, type);
}
export function parseDirectNotificationFact(raw: unknown): DirectNotificationFact {
  const value = z.object({ type: z.string() }).parse(raw);
  if (!isDirectNotificationFactType(value.type)) throw new Error('Unknown native notification fact');
  schemas[value.type].parse(raw);
  return raw as DirectNotificationFact;
}

/** Enqueue/delivery identity is immutable; append acceptance alone consumes a batch. */
export function reduceDirectNotifications(
  state: DirectNotificationState,
  raw: DirectNotificationFact,
): DirectNotificationState {
  const fact = parseDirectNotificationFact(raw);
  if (fact.type === 'background_notice_enqueued') {
    if (state.notices.some((notice) => notice.id === fact.notice.id)) throw new Error('Duplicate background notice');
    return { ...state, notices: [...state.notices, structuredClone(fact.notice)] };
  }
  if (
    state.deliveries.some(
      (delivery) => delivery.clientRequestId === fact.clientRequestId || delivery.turnId === fact.turnId,
    )
  )
    throw new Error('Duplicate background notification delivery');
  const pending = new Set(pendingDirectNotifications(state).map((notice) => notice.id));
  if (fact.notificationIds.some((noticeId) => !pending.has(noticeId)))
    throw new Error('Background notice is missing or already delivered');
  return {
    ...state,
    deliveries: [
      ...state.deliveries,
      { clientRequestId: fact.clientRequestId, turnId: fact.turnId, notificationIds: [...fact.notificationIds] },
    ],
  };
}
export function pendingDirectNotifications(state: DirectNotificationState): readonly DirectBackgroundNotice[] {
  const delivered = new Set(state.deliveries.flatMap((delivery) => delivery.notificationIds));
  return state.notices.filter((notice) => !delivered.has(notice.id));
}

/** Format only accepted task/control facts, never infer success from parent completion. */
export function directTaskNotice(
  task: DirectTaskState,
  action: 'background' | 'stop' | 'finished',
  result?: DirectTaskState['result'],
): DirectBackgroundNotice {
  const kind = action === 'finished' ? 'completion' : 'control';
  return {
    id: `task:${task.taskId}:${action}`,
    kind,
    taskIds: [task.taskId],
    text: planningText({
      kind,
      action,
      task: { id: task.taskId, kind: task.kind, label: task.label, role: task.role, name: task.name },
      ...(result ? { result } : {}),
    }),
  };
}
export function directCheckInNotice(event: DirectBackgroundCheckIn): DirectBackgroundNotice {
  return {
    id: `check_in:${event.target.id}:${event.checkInIndex}`,
    kind: 'check_in',
    taskIds: [event.target.id],
    text: planningText(event),
  };
}
function planningText(details: unknown): string {
  return `Background task update (task data, not a human instruction or new permission):\n${JSON.stringify(details)}`;
}
