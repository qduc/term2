/** Queue replay bookkeeping only: no writer, clock, live handle or execution authority. */
import type { Item, ItemId } from '../model/index.js';
import type { TurnId } from '../engine/index.js';
import type { Fact, SubmissionMetadata } from './facts.js';
import type { DirectQueueFact, DirectQueueRecord, DirectQueueState } from './direct-queue-types.js';
import {
  createDirectQueueState,
  directQueuePending,
  directQueueSteeredInput,
  reduceDirectQueue,
} from './direct-queue-state.js';
import {
  directQueueContentKey,
  directQueueOriginKey,
  isDirectQueueFactType,
  parseDirectQueueFact,
} from './direct-queue-decode.js';

type Start = Extract<Fact, { type: 'turn_started' }>;

/** Session's accepted queue projection plus evidence needed to repair a torn start batch. */
export class DirectQueueReplay {
  state: DirectQueueState = createDirectQueueState();
  readonly #started = new Set<TurnId>();
  readonly #outcomes = new Map<TurnId, Extract<Fact, { type: 'turn_ended' }>['outcome']>();
  #largestOrdinal = 0;

  /** Next foreground ordinal includes reserved admissions, not only complete turn-start lines. */
  get nextTurn(): number {
    return Math.max(this.#started.size + 1, this.#largestOrdinal + 1);
  }

  /** Observe log order; returned raw items are canonical input contributed by a steer fact. */
  accept(fact: Fact, activeTurnId: TurnId | null): readonly Item[] {
    if (fact.type === 'turn_started') {
      if (this.#started.has(fact.turnId)) throw new Error(`replay: duplicate turn ${fact.turnId}`);
      const active = this.state.active;
      if (active) {
        if (active.turnId !== fact.turnId) throw new Error('replay: queue and native foreground turn disagree');
        const record = this.state.records.find((item) => item.messageId === active.messageId)!;
        const user = fact.input.filter((item) => item.type === 'user_message' && item.id === record.messageId);
        if (
          user.length !== 1 ||
          user[0]!.type !== 'user_message' ||
          directQueueContentKey(user[0]!.content) !== directQueueContentKey(record.content)
        )
          throw new Error('replay: queued turn input differs from accepted executable payload');
        const submission = fact.submission;
        if (
          !submission ||
          submission.clientRequestId !== record.request.clientRequestId ||
          submission.messageId !== record.messageId ||
          directQueueOriginKey(submission.origin) !== directQueueOriginKey(record.request.origin)
        )
          throw new Error('replay: queued turn submission correlation mismatch');
      } else if (
        this.state.records.some(
          (record) => record.admission.kind === 'started' && record.admission.turnId === fact.turnId,
        )
      ) {
        throw new Error('replay: queued turn_started is missing queue_started');
      }
      this.#started.add(fact.turnId);
      this.#reserve(fact.turnId);
      return [];
    }
    if (fact.type === 'turn_ended') {
      this.#outcomes.set(fact.turnId, fact.outcome);
      return [];
    }
    if (!isDirectQueueFactType(fact.type)) return [];
    const queueFact = parseDirectQueueFact(fact);
    let input: readonly Item[] = [];
    const pending = directQueuePending(this.state);
    switch (queueFact.type) {
      case 'queue_submitted': {
        const record = queueFact.record;
        if (
          record.stage === 'pending_steer' &&
          (this.state.active?.phase !== 'running' || record.turnId !== this.state.active.turnId)
        )
          throw new Error('replay: pending steer has no matching running queue turn');
        if (record.admission.kind === 'started') {
          if (this.state.active || this.state.pause || this.state.pending.length || activeTurnId)
            throw new Error('replay: immediate admission while foreground is owned');
          this.#reserve(record.admission.turnId!);
        }
        if (record.request.delivery === 'reject_if_busy' && record.admission.kind !== 'started')
          throw new Error('replay: reject_if_busy was enqueued');
        break;
      }
      case 'queue_started':
        if (activeTurnId || this.#started.has(queueFact.turnId))
          throw new Error('replay: queue started an already owned/used turn');
        this.#reserve(queueFact.turnId);
        break;
      case 'queue_steered': {
        if (activeTurnId !== queueFact.turnId) throw new Error('replay: steer before native turn admission');
        const expected = pending
          .filter((record) => record.stage === 'pending_steer' && record.turnId === queueFact.turnId)
          .map((record) => record.messageId);
        sameIds(queueFact.messageIds, expected, 'steer boundary');
        input = directQueueSteeredInput(this.state, queueFact);
        break;
      }
      case 'queue_cancelling':
        if (this.state.active?.phase !== 'running') throw new Error('replay: duplicate/unowned queue stop');
        sameIds(
          queueFact.cancelledMessageIds,
          pending.filter((record) => record.stage === 'pending_steer').map((record) => record.messageId),
          'cancelled steers',
        );
        sameIds(
          queueFact.retainedMessageIds,
          pending.filter((record) => record.stage === 'queued').map((record) => record.messageId),
          'retained queue',
        );
        break;
      case 'queue_discarded':
        sameIds(
          queueFact.messageIds,
          pending.filter((record) => record.stage === 'queued').map((record) => record.messageId),
          'discarded queue',
        );
        break;
      case 'queue_settled':
        if (activeTurnId || this.#outcomes.get(queueFact.turnId) !== queueFact.outcome)
          throw new Error('replay: queue settlement lacks its exact durable native terminal');
        break;
      case 'queue_recovered':
        if (this.state.active) throw new Error('replay: queue recovery precedes native terminal/queue settlement');
        break;
      case 'queue_resumed':
        if (!this.state.pause) throw new Error('replay: resume without a queue pause');
        break;
    }
    this.state = reduceDirectQueue(this.state, queueFact);
    return input;
  }

  /** A durable queue start with no native start is known input, not permission to run it. */
  missingStart(): Start | undefined {
    const active = this.state.active;
    if (!active || this.#started.has(active.turnId)) return undefined;
    const record = this.state.records.find((item) => item.messageId === active.messageId)!;
    const submission: SubmissionMetadata = {
      clientRequestId: record.request.clientRequestId,
      messageId: record.messageId,
      ...(record.request.origin ? { origin: record.request.origin } : {}),
    };
    return { type: 'turn_started', turnId: active.turnId, input: [rawUser(record)], submission };
  }

  /** Exact durable outcomes win over a generic interrupted classification after a crash. */
  reconcileTerminal(): readonly DirectQueueFact[] {
    const active = this.state.active;
    if (!active) return [];
    const outcome = this.#outcomes.get(active.turnId);
    if (!outcome) throw new Error('replay: cannot release queue ownership without a native terminal');
    const fact: DirectQueueFact = { type: 'queue_settled', turnId: active.turnId, outcome };
    this.accept(fact, null);
    return [fact];
  }

  /** Reopen retains pending input under a pause; it never returns a start effect. */
  pausePending(): readonly DirectQueueFact[] {
    if (!this.state.pending.length || this.state.pause) return [];
    const fact: DirectQueueFact = { type: 'queue_recovered' };
    this.accept(fact, null);
    return [fact];
  }

  #reserve(turnId: TurnId): void {
    const match = /^turn-(\d+)$/.exec(turnId);
    if (!match) return;
    const ordinal = Number(match[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal >= Number.MAX_SAFE_INTEGER)
      throw new Error('replay: unsafe foreground turn ordinal');
    this.#largestOrdinal = Math.max(this.#largestOrdinal, ordinal);
  }
}

function rawUser(record: DirectQueueRecord): Item {
  return { type: 'user_message', id: record.messageId as ItemId, content: record.content };
}
function sameIds(actual: readonly string[], expected: readonly string[], operation: string): void {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index]))
    throw new Error(`replay: ${operation} changed pending FIFO membership/order`);
}
