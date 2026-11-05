/** Pure direct-log projection: no writes, dispatch, provider calls or restored authority. */
import type { TurnId } from '../engine/index.js';
import type { Item } from '../model/index.js';
import type { DirectTaskState } from './background-types.js';
import type { DirectCommandReceipts } from './command-types.js';
import type { DirectContextState } from './context.js';
import type { DirectNotificationState } from './notifications.js';
import type { DirectQueueState } from './queue-types.js';
import type { ReplayedConversation as NativeReplayedConversation } from './types.js';
import type { DirectCompactionFact, DirectHistoryFact, Fact } from './facts.js';
import { createReplayFold, type ReplayFold } from './replay-fold.js';

export type ReplayOptions = {
  /** False for live history/root settlement; only explicit reopen recovers/pauses the queue. */
  readonly recoverQueue?: boolean;
  /**
   * False keeps accepted root history. Missing tool results, closures, budget stops,
   * and a terminal are not invented. Busy preview passes false with recoverQueue false.
   */
  readonly recoverActiveTurn?: boolean;
  /** Live means the handle has drained: absent durable admission proves no body ran. */
  readonly rootSettlement?: 'restart' | 'live';
  /**
   * How many facts an earlier process wrote before this one opened the Session. Like legacy, a turn cancelled
   * live drops the step it was in, but one cancelled before a resume keeps its unsuperseded text deltas and
   * its calls with unobserved results.
   */
  readonly openedAt?: number;
};
/** Accepted evidence only. Missing outcome stays unobserved, even after root recovery. */
export type ReplayedCompaction = {
  readonly start: Extract<DirectCompactionFact, { type: 'compaction_started' }>;
  readonly replacement?: DirectHistoryFact;
  readonly outcome?: Exclude<DirectCompactionFact, { type: 'compaction_started' }>;
};
export type ReplayedBranch = {
  readonly branchId: string;
  readonly taskId: string;
  readonly turnId: TurnId;
  /** Only ancestry explicitly recorded on branch_started; absent on older logs. */
  readonly parentTurnId?: TurnId;
  readonly rootTurnId?: TurnId;
  readonly history: readonly Item[];
  /** This branch's attempts only, joined to its actual branch/task/turn identity above. */
  readonly compactions: readonly ReplayedCompaction[];
  readonly status: 'idle' | 'interrupted';
};
export type ReplayedConversation = NativeReplayedConversation & {
  readonly queue: DirectQueueState;
  readonly context: DirectContextState;
  /** Accepted audit state only; explicit task recovery uses a caller-supplied clock. */
  readonly background: readonly DirectTaskState[];
  /** Accepted receipts only. Session's recoverDirectCommands is the sole pending-command writer. */
  readonly commands: DirectCommandReceipts;
  /** Accepted notices only. A drain admission is the sole delivery writer. */
  readonly notifications: DirectNotificationState;
  readonly branches: readonly ReplayedBranch[];
  /** Root attempts only; never accounting, transcript, or recovery instructions. */
  readonly compactions: readonly ReplayedCompaction[];
  readonly compactionState?: {
    readonly rearmAtEstimatedTokens?: number;
    readonly rearmAtRenderedTokens?: number;
    readonly checkpointReceipts?: readonly string[];
  };
};

/**
 * Retains native items in order, with unsuperseded text at its model-step position.
 * Incomplete root occurrences get exactly one known or outcome-unobserved result;
 * nested starts/finishes remain audit only. Recovery facts are returned, not written:
 * Session must append them before the next turn's start, in the supplied order.
 */
export function replay(facts: readonly Fact[], options: ReplayOptions = {}): ReplayedConversation {
  // Open and turn boundaries ask for the same, growing log many times. A log with no active turn and
  // nothing to repair gives the same projection under every option set, so the fold that produced
  // it is kept per facts array (journals only append) and later calls fold just the new facts.
  // A fold that had to apply repairs is consumed by them and dropped.
  const kept = foldCache.get(facts);
  // The options shape the result (queue recovery, root settlement), so a held result is served only to the same options.
  const key = `${options.recoverQueue !== false}|${options.recoverActiveTurn !== false}|${
    options.rootSettlement ?? ''
  }|${options.openedAt ?? 0}`;
  if (kept && kept.length === facts.length && kept.key === key) return kept.result;
  foldCache.delete(facts); // A fold that throws mid-way must not be resumed.
  const fold = kept && kept.length <= facts.length ? kept.fold : createReplayFold();
  for (let i = kept && kept.fold === fold ? kept.length : 0; i < facts.length; i++) fold.consume(facts[i]!);
  const result = fold.finish(options, options.recoverActiveTurn !== false);
  if (result.status === 'idle' && result.recoveryFacts.length === 0)
    foldCache.set(facts, { fold, length: facts.length, key, result });
  return result;
}
const foldCache = new WeakMap<
  readonly Fact[],
  { fold: ReplayFold; length: number; key: string; result: ReplayedConversation }
>();
