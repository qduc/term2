/** Validates the durable rotation/priority-handoff protocol; never mutates provider history. */
import type { TurnId } from '../engine/index.js';
import type { Fact } from './facts.js';
import type { DirectQueueState } from './queue-types.js';
import type { DirectCommandReceipts } from './command-types.js';

const controlHandoff = (
  origin: { readonly kind?: string; readonly id?: string; readonly source?: string } | undefined,
): boolean => origin?.kind === 'control' && origin.id === 'session-rollover' && origin.source === undefined;

export class ReplayRotation {
  private readonly rolloverTurns = new Set<TurnId>();
  private readonly rotationCommands = new Set<string>();
  private rolloverSeed:
    | {
        readonly commandId: string;
        readonly clientRequestId: string;
        readonly messageId: string;
        readonly turnId: TurnId;
        seeded: boolean;
        started: boolean;
      }
    | undefined;
  authorizeSeed(fact: Extract<Fact, { type: 'queue_started' }>, queue: DirectQueueState): void {
    if (!('rolloverCommandId' in fact)) {
      if (this.rolloverSeed && !this.rolloverSeed.started && fact.messageId === this.rolloverSeed.messageId) {
        throw new Error('replay: rollover handoff started without its command marker');
      }
      return;
    }
    const marker = fact.rolloverCommandId;
    if (typeof marker !== 'string' || marker.length === 0) throw new Error('replay: rollover seed command id is empty');
    if (!this.rolloverSeed || this.rolloverSeed.seeded || marker !== this.rolloverSeed.commandId) {
      throw new Error('replay: rollover seed is not the current rotation');
    }
    if (fact.messageId !== this.rolloverSeed.messageId || fact.turnId !== this.rolloverSeed.turnId) {
      throw new Error('replay: rollover seed does not match the rotation handoff');
    }
    const record = queue.records.find((item) => item.messageId === fact.messageId);
    if (
      !record ||
      record.stage !== 'queued' ||
      record.admission.kind !== 'queued' ||
      record.admission.turnId !== fact.turnId ||
      record.turnId !== fact.turnId ||
      record.request.delivery !== 'follow_up' ||
      record.request.clientRequestId !== this.rolloverSeed.clientRequestId ||
      !controlHandoff(record.request.origin)
    ) {
      throw new Error('replay: rollover seed is not the admitted control handoff');
    }
    this.rolloverSeed.seeded = true;
  }

  accept(
    fact: Extract<Fact, { type: 'session_rotated' }>,
    active: boolean,
    sessionId: string | undefined,
    commandReceipts: DirectCommandReceipts,
  ): void {
    if (active) throw new Error('replay: session rotated during an active root');
    if (!sessionId || fact.logicalSessionId !== sessionId) {
      throw new Error('replay: rotation logical id is not the original Session');
    }
    if (this.rolloverSeed && !this.rolloverSeed.started)
      throw new Error('replay: previous rotation handoff was not started');
    const receipt = commandReceipts.find((item) => item.request.commandId === fact.commandId);
    if (!receipt || receipt.outcome !== undefined || receipt.request.operation.kind !== 'rollover') {
      throw new Error('replay: rotation has no pending rollover command');
    }
    if (this.rotationCommands.has(fact.commandId)) throw new Error('replay: rollover command already rotated');
    this.rotationCommands.add(fact.commandId);
    this.rolloverSeed = fact.handoff
      ? {
          commandId: fact.commandId,
          clientRequestId: fact.handoff.clientRequestId,
          messageId: fact.handoff.messageId,
          turnId: fact.handoff.turnId,
          seeded: false,
          started: false,
        }
      : undefined;
  }

  request(turnId: TurnId): void {
    if (this.rolloverTurns.has(turnId)) throw new Error('replay: root already requested rollover');
    this.rolloverTurns.add(turnId);
  }
  /** True means this root is the admitted control handoff, not a human input. */
  start(fact: Extract<Fact, { type: 'turn_started' }>): boolean {
    if (this.rolloverSeed?.seeded && !this.rolloverSeed.started) {
      // The handoff is provider context for the new physical log, not a human admission.
      if (
        fact.turnId !== this.rolloverSeed.turnId ||
        fact.maintenance ||
        fact.silent ||
        fact.retryContext ||
        !controlHandoff(fact.submission?.origin) ||
        fact.submission?.clientRequestId !== this.rolloverSeed.clientRequestId ||
        fact.submission?.messageId !== this.rolloverSeed.messageId
      ) {
        throw new Error('replay: rollover handoff turn does not match its admission');
      }

      this.rolloverSeed.started = true;
      return true;
    } else if (this.rolloverSeed && !this.rolloverSeed.started) {
      throw new Error('replay: rotation handoff started before its priority seed');
    }
    return false;
  }
  assertComplete(): void {
    if (this.rolloverSeed && !this.rolloverSeed.started) throw new Error('replay: rotation handoff was not started');
  }
}
