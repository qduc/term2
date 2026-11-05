/** Prepares and atomically accepts a physical rotation with its optional priority handoff. */
import { randomUUID } from 'node:crypto';
import type { TurnId } from '../engine/index.js';
import type { Item } from '../model/index.js';
import type { Fact } from './facts.js';
import type { TurnRequest, ConversationDeps, StartedConversationTurn } from './types.js';
import type { DirectCommandRequest, DirectCommandOutcome, DirectCommandResult } from './command-types.js';
import type { DirectPreparedConfiguration } from './configuration.js';
import type { CommandAdmission, CommandOwner } from './conversation-command-admission.js';
import type { ConversationJournal } from './conversation-journal.js';
import type { ConversationGeneration, PreparedConversationGeneration } from './conversation-generation.js';
import { parseDirectSessionRotation } from './session-rotation.js';
import { submitDirectQueue } from './queue.js';
import { directPreviewConfiguration } from './preview.js';
import { planDirectCommandFinish } from './command-receipts.js';

export async function runConversationRollover(
  request: Omit<DirectCommandRequest, 'operation'> & {
    operation: Extract<DirectCommandRequest['operation'], { kind: 'rollover' }>;
  },
  owner: CommandOwner,
  {
    id,
    journal,
    generation,
    admission,
    rotationBoundary,
    owns,
    blocked,
    revision,
    finish,
    install,
  }: {
    id: string;
    journal: ConversationJournal;
    generation: ConversationGeneration;
    admission: CommandAdmission;
    rotationBoundary: ConversationDeps['rotationBoundary'];
    owns(): boolean;
    blocked(): boolean;
    revision(): string;
    finish(outcome: DirectCommandOutcome): DirectCommandResult;
    install(candidate: DirectPreparedConfiguration, prepared: PreparedConversationGeneration): void;
  },
): Promise<{ result: DirectCommandResult; started?: StartedConversationTurn }> {
  if (!rotationBoundary)
    return {
      result: finish({
        kind: 'rejected',
        code: 'unavailable',
        message: 'Physical rotation authority is unavailable.',
      }),
    };
  if (blocked())
    return {
      result: finish({
        kind: 'rejected',
        code: 'busy',
        message: 'Settle the foreground and pending decisions before rollover.',
      }),
    };
  const expectedRevision = revision();
  let candidate: DirectPreparedConfiguration | undefined;
  let installed = false;
  try {
    const preparedRollover = await generation.runtime.rollover!(request.operation.request, owner.abort.signal);
    if (preparedRollover.kind === 'rejected') return { result: finish(preparedRollover) };
    candidate = preparedRollover.generation;
    if (admission.closed || journal.failure || owner.abort.signal.aborted)
      return {
        result: finish({
          kind: 'rejected',
          code: 'cancelled',
          message: 'Rollover was cancelled before acceptance.',
        }),
      };
    if (!owns() || revision() !== expectedRevision)
      return {
        result: finish({
          kind: 'rejected',
          code: 'stale',
          message: 'Session history changed during rollover preparation.',
        }),
      };
    if (blocked())
      return {
        result: finish({
          kind: 'rejected',
          code: 'busy',
          message: 'A foreground decision arrived during rollover preparation.',
        }),
      };
    if (Boolean(request.operation.request) !== (preparedRollover.handoff !== undefined))
      throw new Error('Rollover preparation must supply a brief exactly when one was requested');
    const prepared = generation.prepare(candidate);
    const { type: _configurationType, ...selection } = prepared.configurationFact;
    const seedFacts: Fact[] = [];
    let seed:
      | { turnId: TurnId; input: readonly Item[]; submission: NonNullable<TurnRequest['submission']> }
      | undefined;
    let handoff: import('./session-rotation.js').DirectSessionRotationFact['handoff'];
    if (preparedRollover.handoff !== undefined) {
      const clientRequestId = `rollover:${randomUUID()}`;
      const messageId = randomUUID();
      const turnId = admission.newTurnId();
      const origin = { kind: 'control' as const, id: 'session-rollover' };
      const queued = submitDirectQueue(
        journal.queueState,
        {
          clientRequestId,
          content: preparedRollover.handoff,
          origin,
          delivery: 'follow_up',
        },
        { ...admission.environment(), newMessageId: () => messageId, newTurnId: () => turnId, dispatchHeld: true },
      );
      if (queued.result.kind !== 'queued') throw new Error('Rollover handoff could not be admitted');
      const record = queued.state.records.find((entry) => entry.messageId === messageId)!;
      const input: readonly Item[] = [
        {
          type: 'user_message',
          id: messageId as import('../model/index.js').ItemId,
          content: record.content,
        },
      ];
      const submission = { clientRequestId, messageId, origin };
      // Decoder authorizes ONLY this header-correlated priority seed.
      const priorityStart = {
        type: 'queue_started' as const,
        messageId,
        turnId,
        rolloverCommandId: request.commandId,
      };
      seedFacts.push(...queued.facts, priorityStart, {
        type: 'turn_started',
        turnId,
        input,
        submission,
        ...(directPreviewConfiguration(prepared.nextRequest)
          ? {
              requestConfiguration: directPreviewConfiguration(prepared.nextRequest),
            }
          : {}),
      });
      seed = { turnId, input, submission };
      handoff = { clientRequestId, messageId, turnId };
    }
    // Progress during app preparation is valid: capture the REAL head
    // only after the final synchronous foreground/interaction veto.
    const boundary = rotationBoundary();
    const rotation = parseDirectSessionRotation({
      type: 'session_rotated',
      logicalSessionId: id,
      sessionId: preparedRollover.successorId,
      predecessor: { sessionId: boundary.sessionId, throughSeq: boundary.seq },
      commandId: request.commandId,
      ...selection,
      history: [],
      ...(handoff ? { handoff } : {}),
    });
    const finished = planDirectCommandFinish(journal.commandReceipts, request.commandId, {
      kind: 'rolled_over',
      sessionId: id,
    });
    if (!journal.commit([rotation, ...seedFacts, finished])) throw new Error(journal.failure!.message);
    installed = true; // Accepted generation ownership is never discarded.
    install(candidate, prepared);
    const started = seed
      ? admission.start(
          { ...prepared.nextRequest, input: seed.input, submission: seed.submission },
          { turnId: seed.turnId, facts: [], accepted: true, history: [] },
        )
      : undefined;
    return {
      result: {
        kind: 'finished',
        replayed: false,
        receipt: structuredClone(
          journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
        ),
      },
      ...(started ? { started } : {}),
    };
  } finally {
    if (candidate && !installed) await candidate.dispose();
  }
}
