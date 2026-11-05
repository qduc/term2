/** Atomic foreground abort and optional transfer of pending steer content. */
import type { TurnId } from '../engine/index.js';
import type { Fact } from './facts.js';
import type { DirectAbortResult } from './facade-types.js';
import type { DirectQueueEnvironment } from './queue-types.js';
import { directQueuePending, planDirectQueue } from './queue.js';
import type { ConversationJournal } from './conversation-journal.js';
import type { OwnedConversationTurn } from './conversation-turn.js';

export function abortConversation(input: {
  readonly expectedTurnId: TurnId;
  readonly discardQueue: boolean;
  readonly returnSteers: boolean;
  readonly closed: boolean;
  readonly active: OwnedConversationTurn | null;
  readonly completionHeld: TurnId | null;
  readonly facts: readonly Fact[];
  readonly journal: ConversationJournal;
  readonly environment: DirectQueueEnvironment;
}): DirectAbortResult {
  const { expectedTurnId, discardQueue, returnSteers, closed, active, completionHeld, facts, journal, environment } =
    input;
  if (closed || journal.failure)
    return { kind: 'not_admitting', reason: journal.failure?.message ?? 'session is closed' };
  const target = active?.turnId ?? completionHeld;
  if (target !== expectedTurnId || active?.cancelled)
    return {
      kind: 'no_op',
      turnId: expectedTurnId,
      status: facts.some((fact) => fact.type === 'turn_ended' && fact.turnId === expectedTurnId)
        ? 'terminal_accepted'
        : target === expectedTurnId && active?.cancelled
        ? 'cancellation_requested'
        : 'not_current',
    };
  const steers = returnSteers
    ? directQueuePending(journal.queueState)
        .filter((record) => record.stage === 'pending_steer' && record.turnId === expectedTurnId)
        .map((record) => ({
          messageId: record.messageId,
          clientRequestId: record.request.clientRequestId,
          content: structuredClone(record.content),
        }))
    : [];
  const cancel = planDirectQueue(
    journal.queueState,
    { kind: 'cancel', turnId: expectedTurnId, discardPendingSteers: discardQueue || returnSteers },
    environment,
  );
  const discard = discardQueue ? planDirectQueue(cancel.state, { kind: 'discard' }, environment) : undefined;
  const discardedMessageIds =
    discard?.facts.flatMap((fact) => (fact.type === 'queue_discarded' ? [...fact.messageIds] : [])) ?? [];
  if (!journal.commit([...cancel.facts, ...(discard?.facts ?? [])]))
    return { kind: 'not_admitting', reason: journal.failure!.message };
  active?.cancel();
  return {
    kind: 'aborted',
    turnId: expectedTurnId,
    discardedMessageIds,
    ...(returnSteers ? { returnedSteers: steers } : {}),
  };
}
