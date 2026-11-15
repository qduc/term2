/** Accepted journal owner: validate projections before append; expose them only after fsync. */
import type { InteractionRequestId, TurnId } from '../engine/index.js';
import type { ModelError } from '../model/index.js';
import type { ConversationLog } from './log.js';
import type { Fact, FactLine } from './facts.js';
import { isDirectTaskFact } from './facts.js';
import { initialDirectContextState } from './context.js';
import { createDirectQueueState } from './queue.js';
import { recoverDirectBackground, recoverDirectBackgroundNotices } from './background-replay.js';
import { foldFact, type FoldState } from './fold-fact.js';
import type { DirectTaskState } from './background-types.js';
import { recoverDirectCommands } from './command-receipts.js';
import type { DirectCommandReceipts } from './command-types.js';
import type { DirectNotificationState } from './notifications.js';
import type { bindDirectCapabilities } from './capabilities.js';
import { replay } from './replay.js';

/** One synchronous durable boundary shared by root, command and background acceptance. */
export class ConversationJournal {
  #historyRevision = 0;
  #folded: Required<Omit<FoldState, 'queueRecords'>> = {
    commands: [],
    notifications: { notices: [], deliveries: [] },
    context: initialDirectContextState(),
    queue: createDirectQueueState(),
    tasks: [],
  };
  readonly #requestIds = new Set<InteractionRequestId>();
  #recoveryMaterialized = false;
  /** Hook status is folded from each accepted fact once, never rescanned from the whole log. */
  #root: TurnId | undefined;
  readonly #waits = new Map<string, 'approval' | 'question' | 'budget'>();
  #hookStatus: 'idle' | 'working' | 'waiting_for_user' | 'waiting_for_approval' = 'idle';
  #failure: ModelError | null = null;
  constructor(
    readonly log: ConversationLog,
    readonly facts: Fact[],
    readonly sink: {
      accepted(line: FactLine): void;
      status: ReturnType<typeof bindDirectCapabilities>['status'];
      failed(error: ModelError): void;
    },
  ) {
    this.openedAt = this.facts.length;
    this.reopenedAt = this.openedAt;
    for (const fact of this.facts) {
      this.#folded = foldFact(this.#folded, fact);
      if (changesRootHistory(fact)) ++this.#historyRevision;
      if (fact.type === 'interaction_opened' || fact.type === 'task_interaction_opened')
        this.#requestIds.add(fact.request.requestId);
      this.#foldStatus(fact);
    }
  }
  #foldStatus(fact: Fact): void {
    if (fact.type === 'turn_started') {
      this.#root = fact.turnId;
      this.#waits.clear();
    }
    if (fact.type === 'interaction_opened' && fact.turnId === this.#root)
      this.#waits.set(fact.request.requestId, fact.request.kind);
    if (fact.type === 'budget_opened' && fact.turnId === this.#root) this.#waits.set(fact.requestId, 'budget');
    if (fact.type === 'interaction_closed' || fact.type === 'budget_closed') this.#waits.delete(fact.requestId);
    if (fact.type === 'turn_ended' && fact.turnId === this.#root) {
      this.#root = undefined;
      this.#waits.clear();
    }
  }
  #status(): 'idle' | 'working' | 'waiting_for_user' | 'waiting_for_approval' {
    return this.#waits.size
      ? [...this.#waits.values()].some((kind) => kind === 'approval')
        ? 'waiting_for_approval'
        : 'waiting_for_user'
      : this.#root
      ? 'working'
      : 'idle';
  }
  get failure(): ModelError | null {
    return this.#failure;
  }
  get commandReceipts(): DirectCommandReceipts {
    return this.#folded.commands;
  }
  get historyRevision(): number {
    return this.#historyRevision;
  }
  get notifications(): Readonly<DirectNotificationState> {
    return this.#folded.notifications;
  }
  get context() {
    return this.#folded.context;
  }
  get queueState() {
    return this.#folded.queue;
  }
  get taskStates(): readonly DirectTaskState[] {
    return this.#folded.tasks;
  }
  readonly poison = (error: unknown): void => {
    if (this.#failure) return;
    this.#failure = modelError(error);
    this.sink.failed(this.#failure);
  };
  // Projection validation is synchronous and precedes disk mutation. Nothing
  // awaits/reenters between generation CAS, candidate reduction and append.
  readonly commit = (next: readonly Fact[]): boolean => {
    if (this.#failure) return false;
    if (next.length === 0) return true;
    let projected = this.#folded;
    const reserved = new Set<InteractionRequestId>();
    for (const fact of next) {
      projected = foldFact(projected, fact);
      if (fact.type === 'interaction_opened' || fact.type === 'task_interaction_opened') {
        if (reserved.has(fact.request.requestId) || this.#requestIds.has(fact.request.requestId))
          throw new Error('Duplicate Session interaction request ID');
        reserved.add(fact.request.requestId);
      }
    }
    let lines: readonly FactLine[];
    try {
      lines = this.log.append(next);
    } catch (error) {
      this.poison(error);
      return false;
    }
    this.#folded = projected;
    this.#historyRevision += next.filter(changesRootHistory).length;
    for (const requestId of reserved) this.#requestIds.add(requestId);
    for (const fact of next) this.facts.push(fact);
    for (const line of lines) this.sink.accepted(line);
    for (const fact of next) this.#foldStatus(fact);
    const current = this.#status();
    if (current !== this.#hookStatus) {
      this.sink.status(
        this.#hookStatus,
        current,
        current === 'idle' ? 'turn_finished' : this.#waits.size ? 'approval_requested' : 'turn_started',
        this.#root,
      );
      this.#hookStatus = current;
    }

    return true;
  };
  /** How many facts were already accepted when this process opened the Session (zero for a new one). */
  readonly openedAt: number;
  /** The facts an earlier process wrote plus the recovery this one appended on open; later facts are live. */
  reopenedAt: number;
  readonly liveReplay = () => replay(this.facts, { recoverQueue: false, openedAt: this.openedAt });
  /** Use only after the sole handle reader has drained all execution cleanup. */
  readonly settledReplay = () =>
    replay(this.facts, { recoverQueue: false, rootSettlement: 'live', openedAt: this.openedAt });
  readonly recover = (): boolean => {
    if (this.#recoveryMaterialized) return !this.#failure;
    const recovered = replay(this.facts);
    const taskFacts = this.facts.filter(isDirectTaskFact);
    const taskRecovery = recoverDirectBackground(taskFacts, Date.now());
    if (
      !this.commit([
        ...recovered.recoveryFacts,
        ...taskRecovery,
        ...recoverDirectBackgroundNotices(taskFacts, taskRecovery),
        ...recoverDirectCommands(this.#folded.commands),
      ])
    )
      return false;
    this.reopenedAt = this.facts.length;
    this.#recoveryMaterialized = true;
    return true;
  };
}

export function modelError(error: unknown): ModelError {
  return { kind: 'provider', message: error instanceof Error ? error.message : String(error), retryable: false };
}

/** Physical audit/branch progress and compaction lifecycle do not invalidate a
 * root history token. For compaction, history_replaced alone owns transcript mutation. */
function changesRootHistory(fact: Fact): boolean {
  return [
    'turn_started',
    'turn_ended',
    'text_delta',
    'item',
    'history_replaced',
    'configuration_changed',
    'session_rotated',
    'queue_steered',
    'memory_personal_snapshot',
  ].includes(fact.type);
}

/** Find the next unused numeric turn ID, including queued admissions. */
export function nextConversationTurnId(facts: readonly Fact[]): number {
  let nextId = 1;
  for (const fact of facts) {
    const candidates = [
      'turnId' in fact ? fact.turnId : undefined,
      fact.type === 'queue_submitted' ? fact.record.admission.turnId : undefined,
    ];
    for (const value of candidates) {
      const match = value?.match(/^turn-(\d+)$/);
      if (match) nextId = Math.max(nextId, Number(match[1]) + 1);
    }
  }
  return nextId;
}
