/** Accepted journal owner: validate projections before append; expose them only after fsync. */
import type { InteractionRequestId, TurnId } from '../engine/index.js';
import type { ModelError } from '../model/index.js';
import type { ConversationLog } from './log.js';
import type { Fact, FactLine } from './facts.js';
import { isDirectTaskFact, isDirectQueueFact } from './facts.js';
import { initialDirectContextState, reduceDirectContext } from './direct-context.js';
import { createDirectQueueState, reduceDirectQueue } from './direct-queue.js';
import { reduceDirectBackground, recoverDirectBackground } from './direct-background-replay.js';
import type { DirectTaskState } from './direct-background-types.js';
import {
  isDirectCommandFactType,
  reduceDirectCommandReceipts,
  recoverDirectCommands,
} from './direct-command-receipts.js';
import type { DirectCommandFact, DirectCommandReceipts } from './direct-command-types.js';
import {
  isDirectNotificationFactType,
  reduceDirectNotifications,
  type DirectNotificationFact,
  type DirectNotificationState,
} from './direct-notifications.js';
import type { bindDirectCapabilities } from './direct-capabilities.js';
import { replay } from './replay.js';

/** One synchronous durable boundary shared by root, command and background acceptance. */
export class ConversationJournal {
  #commandReceipts: DirectCommandReceipts = [];
  #historyRevision = 0;
  #notifications: DirectNotificationState = { notices: [], deliveries: [] };
  #context = initialDirectContextState();
  #queueState = createDirectQueueState();
  #taskStates: readonly DirectTaskState[] = [];
  readonly #requestIds = new Set<InteractionRequestId>();
  #recoveryMaterialized = false;
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
    for (const fact of this.facts) {
      if (isDirectCommandFactType(fact.type))
        this.#commandReceipts = reduceDirectCommandReceipts(this.#commandReceipts, fact as DirectCommandFact);
      if (isDirectNotificationFactType(fact.type))
        this.#notifications = reduceDirectNotifications(this.#notifications, fact as DirectNotificationFact);
      if (changesRootHistory(fact)) ++this.#historyRevision;
      this.#context = reduceDirectContext(this.#context, fact, this.#queueState.records);
      if (isDirectQueueFact(fact)) this.#queueState = reduceDirectQueue(this.#queueState, fact);
      if (isDirectTaskFact(fact)) this.#taskStates = reduceDirectBackground(this.#taskStates, fact);
      if (fact.type === 'interaction_opened' || fact.type === 'task_interaction_opened')
        this.#requestIds.add(fact.request.requestId);
    }
  }
  get failure(): ModelError | null {
    return this.#failure;
  }
  get commandReceipts(): DirectCommandReceipts {
    return this.#commandReceipts;
  }
  get historyRevision(): number {
    return this.#historyRevision;
  }
  get notifications(): Readonly<DirectNotificationState> {
    return this.#notifications;
  }
  get context() {
    return this.#context;
  }
  get queueState() {
    return this.#queueState;
  }
  get taskStates(): readonly DirectTaskState[] {
    return this.#taskStates;
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
    let projectedNotices = this.#notifications;
    let projectedReceipts = this.#commandReceipts;
    let projectedContext = this.#context;
    let projectedQueue = this.#queueState;
    let projectedTasks = this.#taskStates;
    const reserved = new Set(this.#requestIds);
    for (const fact of next) {
      if (isDirectNotificationFactType(fact.type))
        projectedNotices = reduceDirectNotifications(projectedNotices, fact as DirectNotificationFact);
      if (isDirectCommandFactType(fact.type))
        projectedReceipts = reduceDirectCommandReceipts(projectedReceipts, fact as DirectCommandFact);
      projectedContext = reduceDirectContext(projectedContext, fact, projectedQueue.records);
      if (isDirectQueueFact(fact)) projectedQueue = reduceDirectQueue(projectedQueue, fact);
      if (isDirectTaskFact(fact)) projectedTasks = reduceDirectBackground(projectedTasks, fact);
      if (fact.type === 'interaction_opened' || fact.type === 'task_interaction_opened') {
        if (reserved.has(fact.request.requestId)) throw new Error('Duplicate Session interaction request ID');
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
    this.#notifications = projectedNotices;
    this.#commandReceipts = projectedReceipts;
    this.#historyRevision += next.filter(changesRootHistory).length;
    this.#context = projectedContext;
    this.#queueState = projectedQueue;
    this.#taskStates = projectedTasks;
    for (const requestId of reserved) this.#requestIds.add(requestId);
    this.facts.push(...next);
    for (const line of lines) this.sink.accepted(line);
    let root: TurnId | undefined;
    const waits = new Map<string, 'approval' | 'question' | 'budget'>();
    for (const fact of this.facts) {
      if (fact.type === 'turn_started') {
        root = fact.turnId;
        waits.clear();
      }
      if (fact.type === 'interaction_opened' && fact.turnId === root)
        waits.set(fact.request.requestId, fact.request.kind);
      if (fact.type === 'budget_opened' && fact.turnId === root) waits.set(fact.requestId, 'budget');
      if (fact.type === 'interaction_closed' || fact.type === 'budget_closed') waits.delete(fact.requestId);
      if (fact.type === 'turn_ended' && fact.turnId === root) {
        root = undefined;
        waits.clear();
      }
    }
    const current = waits.size
      ? [...waits.values()].some((kind) => kind === 'approval')
        ? 'waiting_for_approval'
        : 'waiting_for_user'
      : root
      ? 'working'
      : 'idle';
    if (current !== this.#hookStatus) {
      this.sink.status(
        this.#hookStatus,
        current,
        current === 'idle' ? 'turn_finished' : waits.size ? 'approval_requested' : 'turn_started',
        root,
      );
      this.#hookStatus = current;
    }

    return true;
  };
  readonly liveReplay = () => replay(this.facts, { recoverQueue: false });
  /** Use only after the sole handle reader has drained all execution cleanup. */
  readonly settledReplay = () => replay(this.facts, { recoverQueue: false, rootSettlement: 'live' });
  readonly recover = (): boolean => {
    if (this.#recoveryMaterialized) return !this.#failure;
    const recovered = replay(this.facts);
    const taskRecovery = recoverDirectBackground(this.facts.filter(isDirectTaskFact), Date.now());
    if (!this.commit([...recovered.recoveryFacts, ...taskRecovery, ...recoverDirectCommands(this.#commandReceipts)]))
      return false;
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
