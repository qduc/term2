/**
 * Queue/steering policy, not a run loop. Session serializes planning with its
 * single writer, appends facts plus companion turn-start facts, installs state,
 * then releases the effect. A plan alone never admits input or runs anything.
 */
import { directQueueContentKey, directQueueOriginKey, validDirectQueueOrigin } from './queue-decode.js';
import { STEERING_NOTICE } from '../engine/prompts/steering-notice.js';
import type { TurnId } from '../engine/index.js';
import type { ContentPart, Item, ItemId } from '../model/index.js';
import type { DirectAdmission } from './facade-types.js';
import {
  directQueueEditedContent,
  directQueuePending,
  directQueueSteeredInput,
  reduceDirectQueue,
} from './queue-state.js';
import type {
  DirectQueueAdmission,
  DirectQueueCommand,
  DirectQueueEffect,
  DirectQueueEnvironment,
  DirectQueueFact,
  DirectQueueMutation,
  DirectQueuePlan,
  DirectQueueRecord,
  DirectQueueState,
  DirectQueueSubmission,
} from './queue-types.js';

export {
  createDirectQueueState,
  directQueuePending,
  directQueueSteeredInput,
  reduceDirectQueue,
} from './queue-state.js';
export type * from './queue-types.js';

/**
 * Admit the original body once. Identical request-ID retries return the original
 * admission, even after editing/retraction/completion; conflicting bodies reject.
 * Idle submissions plan one start; busy steers park until a request boundary.
 * Session commits the batch before acknowledging admission or releasing effects.
 */
export function submitDirectQueue(
  state: DirectQueueState,
  request: DirectQueueSubmission,
  environment: DirectQueueEnvironment,
  expectedSteerTurnId?: TurnId,
): DirectQueuePlan<DirectAdmission> {
  const delivery = request.delivery === undefined || request.delivery === 'auto' ? 'follow_up' : request.delivery;
  const body = structuredClone({ ...request, delivery });
  const reject = (reason: string) =>
    makePlan(state, [], { kind: 'rejected' as const, clientRequestId: request.clientRequestId, reason });
  if (
    !body.clientRequestId ||
    !validContent(body.content) ||
    !validDirectQueueOrigin(body.origin) ||
    (body.delivery !== 'steer' && body.delivery !== 'follow_up' && body.delivery !== 'reject_if_busy')
  )
    return reject('invalid');
  const previous = state.records.find((record) => record.request.clientRequestId === body.clientRequestId);
  if (previous) {
    if (submissionKey(previous.request) !== submissionKey(body)) return reject('request_conflict');
    return makePlan(state, [], {
      kind: 'duplicate',
      clientRequestId: body.clientRequestId,
      original: previous.admission,
    });
  }
  if (
    expectedSteerTurnId &&
    (body.delivery !== 'steer' || state.active?.turnId !== expectedSteerTurnId || state.active.phase !== 'running')
  )
    return reject('steer_target_stopped');
  const busy = Boolean(environment.dispatchHeld || state.active || state.pause || state.pending.length);
  if (body.delivery === 'reject_if_busy' && busy) return reject('busy');
  const steering = body.delivery === 'steer' && state.active?.phase === 'running';
  const capacity = environment.capacity ?? Infinity;
  if (capacity !== Infinity && (!Number.isInteger(capacity) || capacity < 0))
    throw new Error('queue: capacity must be a nonnegative integer or Infinity');
  // A steer already accepted by the turn must not later disappear because its
  // fallback queue fills. The optional capacity applies to ordinary admission.
  if (!steering && directQueuePending(state).filter((record) => record.stage === 'queued').length >= capacity)
    return reject('queue_full');
  const messageId = environment.newMessageId();
  if (!messageId || state.records.some((record) => record.messageId === messageId))
    throw new Error('queue: message ID allocator returned a reused or empty ID');
  const immediate = !busy;
  const turnId = steering ? state.active!.turnId : nextTurnId(state, environment);
  const admission: DirectQueueAdmission = {
    kind: immediate ? 'started' : steering ? 'steering' : 'queued',
    clientRequestId: body.clientRequestId,
    messageId,
    ...(turnId === undefined ? {} : { turnId }),
  };
  const record: DirectQueueRecord = {
    request: body,
    messageId,
    receivedAt: environment.now(),
    content: body.content,
    admission,
    stage: steering ? 'pending_steer' : 'queued',
    turnId,
  };
  const facts: DirectQueueFact[] = [{ type: 'queue_submitted', record }];
  if (immediate) {
    facts.push({ type: 'queue_started', messageId, turnId: turnId! });
    const plan = makePlan(state, facts, admission);
    const started = plan.state.records.find((item) => item.messageId === messageId)!;
    return { ...plan, effect: startEffect(started, turnId!) };
  }
  return makePlan(state, facts, admission);
}

/**
 * Plan one Session command. Retract/edit never touch a running effect; dispatch
 * is explicit so the Session completion barrier can precede queue advancement.
 * No-op boundary/cancel/terminal commands for stale turn IDs release no effect.
 */
export function planDirectQueue(
  state: DirectQueueState,
  command: DirectQueueCommand,
  environment: DirectQueueEnvironment,
): DirectQueuePlan {
  switch (command.kind) {
    case 'edit': {
      const record = directQueuePending(state).find((item) => item.messageId === command.messageId);
      if (!record) return makePlan(state, [], { kind: 'too_late' });
      const content = directQueueEditedContent(record.content, command.edit);
      if (!validContent(content)) return makePlan(state, [], { kind: 'rejected', reason: 'invalid' });
      return makePlan(state, [{ type: 'queue_edited', messageId: record.messageId, content }], { kind: 'accepted' });
    }
    case 'retract':
      if (!state.pending.includes(command.messageId)) return makePlan(state, [], { kind: 'too_late' });
      return makePlan(state, [{ type: 'queue_retracted', messageId: command.messageId }], { kind: 'accepted' });
    case 'discard': {
      // Pending steers live in the active turn's mailbox, not its follow-up
      // queue. Match discardQueue: retract/cancel is how to remove those.
      const messageIds = directQueuePending(state)
        .filter((record) => record.stage === 'queued')
        .map((record) => record.messageId);
      if (!messageIds.length) return makePlan(state, [], { kind: 'no_op' });
      return makePlan(state, [{ type: 'queue_discarded', messageIds }], { kind: 'accepted' });
    }
    case 'resume':
      if (state.active || !state.pause) return makePlan(state, [], { kind: 'no_op' });
      return makePlan(state, [{ type: 'queue_resumed' }], { kind: 'accepted' });
    case 'dispatch': {
      if (environment.dispatchHeld || state.active || state.pause || !state.pending.length)
        return makePlan(state, [], { kind: 'no_op' });
      const record = directQueuePending(state)[0]!;
      const turnId =
        record.admission.kind === 'queued' && record.admission.turnId
          ? record.admission.turnId
          : nextTurnId(state, environment);
      const plan = makePlan(state, [{ type: 'queue_started', messageId: record.messageId, turnId }], {
        kind: 'accepted',
      });
      const started = plan.state.records.find((item) => item.messageId === record.messageId)!;
      return { ...plan, effect: startEffect(started, turnId) };
    }
    case 'boundary': {
      if (state.active?.turnId !== command.turnId || state.active.phase !== 'running')
        return makePlan(state, [], { kind: 'no_op' });
      const records = directQueuePending(state).filter(
        (record) => record.stage === 'pending_steer' && record.turnId === command.turnId,
      );
      if (!records.length) return makePlan(state, [], { kind: 'no_op' });
      const fact: Extract<DirectQueueFact, { type: 'queue_steered' }> = {
        type: 'queue_steered',
        turnId: command.turnId,
        messageIds: records.map((record) => record.messageId),
      };
      return makePlan(
        state,
        [fact],
        { kind: 'accepted' },
        {
          kind: 'steer',
          turnId: command.turnId,
          input: directQueueSteeredInput(state, fact),
          modelInput: records.map(steeringItem),
        },
      );
    }
    case 'cancel': {
      if (!state.active) {
        if (command.turnId === undefined && state.pause === 'manual')
          return makePlan(state, [{ type: 'queue_resumed' }], { kind: 'accepted' });
        return makePlan(state, [], { kind: 'no_op' });
      }
      if (
        (command.turnId !== undefined && state.active.turnId !== command.turnId) ||
        state.active.phase === 'cancelling'
      )
        return makePlan(state, [], { kind: 'no_op' });
      const turnId = state.active.turnId;
      const pending = directQueuePending(state);
      return makePlan(
        state,
        [
          {
            type: 'queue_cancelling',
            turnId,
            cancelledMessageIds: command.discardPendingSteers
              ? pending.filter((record) => record.stage === 'pending_steer').map((record) => record.messageId)
              : [],
            retainedMessageIds: pending.filter((record) => record.stage === 'queued').map((record) => record.messageId),
            ...(!command.discardPendingSteers ? { preservePendingSteers: true } : {}),
          },
        ],
        { kind: 'accepted' },
        { kind: 'cancel', turnId },
      );
    }
    case 'settled':
      if (state.active?.turnId !== command.turnId) return makePlan(state, [], { kind: 'no_op' });
      return makePlan(
        state,
        [
          {
            type: 'queue_settled',
            turnId: command.turnId,
            outcome: command.outcome,
            ...(command.preservePendingSteers ? { preservePendingSteers: true } : {}),
          },
        ],
        {
          kind: 'accepted',
        },
      );
    case 'recover':
      if (!state.active && (!state.pending.length || state.pause)) return makePlan(state, [], { kind: 'no_op' });
      return makePlan(state, [{ type: 'queue_recovered' }], { kind: 'accepted' });
  }
}

function makePlan<Result extends DirectQueueMutation | DirectAdmission>(
  state: DirectQueueState,
  facts: readonly DirectQueueFact[],
  result: Result,
  effect?: DirectQueueEffect,
): DirectQueuePlan<Result> {
  return { facts, state: facts.reduce(reduceDirectQueue, state), result, ...(effect ? { effect } : {}) };
}

function nextTurnId(state: DirectQueueState, environment: DirectQueueEnvironment): TurnId {
  const turnId = environment.newTurnId();
  if (!turnId || state.records.some((record) => record.turnId === turnId || record.admission.turnId === turnId)) {
    throw new Error('queue: turn ID allocator returned a reused or empty ID');
  }
  return turnId;
}

function userItem(record: DirectQueueRecord): Item {
  return { type: 'user_message', id: record.messageId as ItemId, content: record.content };
}

function startEffect(record: DirectQueueRecord, turnId: TurnId): DirectQueueEffect {
  return { kind: 'start', turnId, record, input: [userItem(record)] };
}

function steeringItem(record: DirectQueueRecord): Item {
  let prefixed = false;
  const content: ContentPart[] = record.content.map((part) => {
    if (prefixed || part.type !== 'text') return part;
    prefixed = true;
    return { type: 'text', text: `${STEERING_NOTICE}\n\n${part.text}` };
  });
  if (!prefixed) content.unshift({ type: 'text', text: STEERING_NOTICE });
  return { type: 'user_message', id: record.messageId as ItemId, content };
}

function validContent(content: readonly ContentPart[]): boolean {
  return (
    content.length > 0 &&
    content.every((part) =>
      part.type === 'text'
        ? typeof part.text === 'string'
        : part.type === 'image' &&
          typeof part.data === 'string' &&
          Boolean(part.data) &&
          typeof part.mediaType === 'string' &&
          Boolean(part.mediaType),
    ) &&
    content.some((part) => part.type === 'image' || part.text.trim().length > 0)
  );
}

// Compare the domain body, not object property insertion order or dispatch time.
function submissionKey(request: DirectQueueSubmission): string {
  return JSON.stringify([
    request.delivery === undefined || request.delivery === 'auto' ? 'follow_up' : request.delivery,
    directQueueContentKey(request.content),
    directQueueOriginKey(request.origin),
    request.humanInputAt ?? null,
  ]);
}
