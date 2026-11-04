/** Durable planning notices, delivered only by the Session's atomic silent admission. */
import { z } from 'zod';
import type { TurnId } from '../engine/index.js';
import type { NestedRunResult } from '../tools/index.js';
import type { DirectTaskId, DirectTaskState, DirectTaskResult } from './direct-background-types.js';
import type { DirectBackgroundCheckIn } from './direct-background-check-ins.js';
import {
  formatDirectLegacyNotifications,
  type DirectLegacyNotification,
  type DirectTaskActivityDetails,
} from './direct-notice-format.js';

export type DirectBackgroundNotice = {
  readonly id: string;
  readonly kind: 'completion' | 'control' | 'check_in' | 'question';
  readonly taskIds: readonly DirectTaskId[];
  /** Session-produced planning input, not a human message or an authority grant. */
  readonly text: string;
  /** Legacy's notification shape, so a batch is grouped as legacy groups it. Absent on older logs. */
  readonly legacy?: DirectLegacyNotification;
};
export type DirectNoticeDelivery = {
  readonly clientRequestId: string;
  readonly turnId: TurnId;
  readonly notificationIds: readonly string[];
  /**
   * Delivered into an already running turn at a request boundary, as legacy does, rather than to a silent turn of
   * its own: the user message that turn admitted.
   */
  readonly injected?: { readonly messageId: string; readonly text: string };
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
  .object({
    id,
    kind: z.enum(['completion', 'control', 'check_in', 'question']),
    taskIds: ids,
    text: id,
    legacy: z.object({ kind: z.string() }).passthrough().optional(),
  })
  .strict();
const schemas = {
  background_notice_enqueued: z
    .object({ type: z.literal('background_notice_enqueued'), notice: noticeSchema })
    .strict(),
  background_notices_delivered: z
    .object({
      type: z.literal('background_notices_delivered'),
      clientRequestId: id,
      turnId: id,
      notificationIds: ids,
      injected: z.object({ messageId: id, text: id }).strict().optional(),
    })
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
      (delivery) =>
        delivery.clientRequestId === fact.clientRequestId ||
        (!fact.injected && !delivery.injected && delivery.turnId === fact.turnId),
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
      {
        clientRequestId: fact.clientRequestId,
        turnId: fact.turnId,
        notificationIds: [...fact.notificationIds],
        ...(fact.injected ? { injected: { ...fact.injected } } : {}),
      },
    ],
  };
}
export function pendingDirectNotifications(state: DirectNotificationState): readonly DirectBackgroundNotice[] {
  const delivered = new Set(state.deliveries.flatMap((delivery) => delivery.notificationIds));
  return state.notices.filter((notice) => !delivered.has(notice.id));
}

/** Legacy text for one notice; a delivered batch is rendered together (directNoticeText). */
function legacyNotice(
  id: string,
  kind: DirectBackgroundNotice['kind'],
  taskId: DirectTaskId,
  legacy: DirectLegacyNotification,
): DirectBackgroundNotice {
  return { id, kind, taskIds: [taskId], text: formatDirectLegacyNotifications([legacy]), legacy };
}

/** One delivery's planning input: legacy groups every pending notification into one instruction. */
export function directNoticeText(notices: readonly DirectBackgroundNotice[]): string {
  if (notices.every((notice) => notice.legacy))
    return formatDirectLegacyNotifications(notices.map((notice) => notice.legacy!));
  return notices.map((notice) => notice.text).join('\n\n');
}

function controlDetails(task: DirectTaskState) {
  return task.kind === 'shell'
    ? { kind: 'shell' as const, id: task.taskId, command: task.label }
    : {
        kind: 'subagent' as const,
        id: task.taskId,
        ...(task.name ? { name: task.name } : {}),
        role: task.role ?? 'agent',
        task: task.label,
      };
}

/** Legacy's shell completion: status from the process result, output or else the failure (agent-client.ts). */
function shellCompletion(task: DirectTaskState, result: DirectTaskResult, at?: number): DirectLegacyNotification {
  const value = result.value as { readonly output?: string; readonly status?: string } | undefined;
  // Legacy spawns at once, so even a job cancelled before its process started reports a cancelled run.
  const cancelledUnstarted =
    result.kind === 'cancelled' && value?.output === undefined
      ? [
          'cancelled',
          `Runtime: ${Math.max(0, Math.round((at ?? task.startedAt) - task.startedAt))}ms`,
          'Interrupted: the command was cancelled before completing.',
          'Output may be partial and effects may already have occurred.',
        ].join('\n')
      : undefined;
  const error = result.kind === 'failed' && value === undefined ? result.error.message : undefined;
  const status =
    result.kind === 'cancelled' ? 'cancelled' : value?.status ?? (result.kind === 'completed' ? 'completed' : 'failed');
  return {
    kind: 'shell_completion',
    jobId: task.taskId,
    command: task.label,
    status,
    output: value?.output ?? error ?? cancelledUnstarted ?? '',
    ...(error ? { error } : {}),
  };
}

/** Format only accepted task/control facts, never infer success from parent completion. */
export function directTaskNotice(
  task: DirectTaskState,
  action: 'background' | 'stop' | 'finished',
  result?: DirectTaskState['result'],
  at?: number,
): DirectBackgroundNotice {
  const id = `task:${task.taskId}:${action}`;
  if (action !== 'finished')
    return legacyNotice(id, 'control', task.taskId, { kind: 'user_control', action, details: controlDetails(task) });
  if (result && task.kind === 'subagent')
    return legacyNotice(
      id,
      'completion',
      task.taskId,
      subagentCompletion(task, result as DirectTaskResult<NestedRunResult>),
    );
  if (result) return legacyNotice(id, 'completion', task.taskId, shellCompletion(task, result, at));
  return {
    id,
    kind: 'completion',
    taskIds: [task.taskId],
    text: planningText({
      kind: 'completion',
      action,
      task: { id: task.taskId, kind: task.kind, label: task.label, role: task.role, name: task.name },
    }),
  };
}
/** Correlation and instructions are Session planning input, never a user prompt. */
export function directQuestionNotice(
  task: DirectTaskState,
  question: import('./direct-background-types.js').DirectOrchestratorQuestion,
): DirectBackgroundNotice {
  return legacyNotice(`question:${task.taskId}:${question.messageId}`, 'question', task.taskId, {
    kind: 'question',
    messageId: question.messageId,
    runId: task.taskId,
    ...(task.name ? { name: task.name } : {}),
    role: task.role ?? 'agent',
    question: question.question,
  });
}
export function directCheckInNotice(
  event: DirectBackgroundCheckIn,
  activity: DirectTaskActivityDetails = {},
): DirectBackgroundNotice {
  const task = event.details;
  return legacyNotice(`check_in:${event.target.id}:${event.checkInIndex}`, 'check_in', event.target.id, {
    kind: 'check_in',
    checkInIndex: event.checkInIndex,
    elapsedMs: event.elapsedMs,
    details:
      task.kind === 'shell'
        ? { kind: 'shell', id: task.taskId, command: task.label, ...activity, status: 'running' }
        : {
            ...(controlDetails(task) as Extract<ReturnType<typeof controlDetails>, { kind: 'subagent' }>),
            ...activity,
          },
  });
}
/** A shell watch firing (the source watch's firing record) as legacy's shell_output notification. */
export function directShellOutputNotice(task: DirectTaskState, key: string, firing: string): DirectBackgroundNotice {
  const parsed = JSON.parse(firing) as {
    readonly watchId: string;
    readonly seq: number;
    readonly matchedLines: string;
    readonly droppedBytes?: number;
  };
  return legacyNotice(`shell_output:${task.taskId}:${key}`, 'control', task.taskId, {
    kind: 'shell_output',
    jobId: task.taskId,
    command: task.label,
    watchId: parsed.watchId,
    seq: parsed.seq,
    matchedLines: parsed.matchedLines,
    ...(parsed.droppedBytes !== undefined ? { droppedBytes: parsed.droppedBytes } : {}),
  });
}
function planningText(details: unknown): string {
  return `Background task update (task data, not a human instruction or new permission):\n${JSON.stringify(details)}`;
}

/** Source-compatible wording over accepted native results, not legacy events. */
function subagentCompletion(
  task: DirectTaskState,
  result: DirectTaskResult<NestedRunResult>,
): DirectLegacyNotification {
  const error = result.kind === 'failed' ? result.error.message : undefined;
  const final = result.value?.items.filter((item) => item.type === 'assistant_message').at(-1);
  const text = final?.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  const lines = [
    `Status: ${result.kind}`,
    ...(error ? [`Error: ${error}`] : []),
    ...(result.kind === 'interrupted' ? [`Termination cause: ${result.reason}`] : []),
    ...(text ? ['', text] : []),
  ];
  const counts = result.value?.toolUseCounts;
  if (counts?.length)
    lines.push('', `Tools used: ${counts.map((tool) => `${tool.toolName}(${tool.count})`).join(', ')}`);
  return {
    kind: 'completion',
    runId: task.taskId,
    role: task.role ?? 'agent',
    status: result.kind,
    ...(error ? { error } : {}),
    formattedResult: lines.join('\n'),
  };
}
