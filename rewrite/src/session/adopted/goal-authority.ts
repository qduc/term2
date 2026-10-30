import { isDeepStrictEqual } from 'node:util';
import type { DurableGoal } from '../../../../source/services/logging/conversation-log-events.js';
import type { SessionEventReference, SessionFact } from '../index.js';
import { validateSessionFact, type SessionLogEntry } from './conversation-log.js';

export type GoalRevision = SessionEventReference | null;
export type GoalMutationResult = 'applied' | 'stale';

/** Manual goal commands; the revision is the canonical event that set the current goal. */
export interface SessionGoalControl {
  get(): { readonly goal: DurableGoal | undefined; readonly revision: GoalRevision };
  set(goal: DurableGoal, expected: GoalRevision): Promise<GoalMutationResult>;
}

type Commit = (facts: readonly SessionFact[]) => Promise<readonly SessionLogEntry[]>;

/**
 * The session goal is the last canonical `goal_changed` fact, and this is the
 * only adopted writer of that fact. Every write compares and appends inside one
 * queue, and the queue never waits on a running turn, so a goal callback from
 * inside a turn and a manual `/goal` can never deadlock. Like the old CLI, a
 * manual change does not interrupt a running turn: a `goal_check` names the
 * goal it judged, so it cannot close a goal that replaced it.
 */
export function createGoalAuthority(entries: readonly SessionLogEntry[]) {
  let current: { goal: DurableGoal | undefined; revision: GoalRevision } = { goal: undefined, revision: null };
  for (const entry of entries)
    if (entry.fact.type === 'goal_changed') current = { goal: { ...entry.fact.goal }, revision: entry.ref };
  let proposalAttempted = false;
  let commit: Commit | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Inside the goal queue, append `goal` only if `expected` still holds.
   * Resolves false, without writing, when it no longer does.
   */
  const write = (goal: DurableGoal, source: 'goal_check' | undefined, expected: () => boolean): Promise<boolean> => {
    const operation = queue.then(async () => {
      if (!commit) throw new Error('Goal writer is not bound');
      if (!expected()) return false;
      const owned = { ...goal };
      const [entry] = await commit([{ type: 'goal_changed', version: 1, goal: owned, ...(source ? { source } : {}) }]);
      current = { goal: owned, revision: entry!.ref };
      return true;
    });
    queue = operation.catch(() => {});
    return operation;
  };

  const control: SessionGoalControl = {
    get: () => ({
      goal: current.goal && { ...current.goal },
      revision: current.revision && { ...current.revision },
    }),
    set(goal, expected) {
      let owned: DurableGoal;
      let expectedRef: GoalRevision;
      try {
        owned = parseGoal(goal);
        expectedRef = parseRevision(expected);
      } catch (error) {
        return Promise.reject(error);
      }
      return write(owned, undefined, () => sameRevision(current.revision, expectedRef)).then((applied) =>
        applied ? 'applied' : 'stale',
      );
    },
  };

  return {
    control,
    /**
     * Late-bound so the foreground's writer flushes buffered turn facts first.
     * A proposal already in the replayed history, approved or rejected, uses up
     * the once-per-session proposal, as in the old CLI.
     */
    bind(writer: Commit, history: readonly unknown[]): void {
      commit = writer;
      proposalAttempted = history.some(
        (item) =>
          (item as { type?: unknown }).type === 'function_call' && (item as { name?: unknown }).name === 'propose_goal',
      );
    },
    /** Source callbacks for the session's own AgentClient. */
    clientDeps: {
      getGoal: () => current.goal && { ...current.goal },
      /** The stop seam read an active goal; close exactly that goal or report failure. */
      async onGoalAchieved(achieved: DurableGoal): Promise<void> {
        const stillJudged = () =>
          current.goal?.status === 'active' && isDeepStrictEqual({ ...current.goal, status: 'achieved' }, achieved);
        if (!(await write(achieved, 'goal_check', stillJudged)))
          throw new Error('The goal changed before completion was recorded.');
      },
      proposeGoal: {
        async appendGoal(goal: DurableGoal): Promise<void> {
          if (!(await write(goal, undefined, () => current.goal === undefined)))
            throw new Error('A durable goal was set while the proposal waited.');
          proposalAttempted = true;
        },
        hasPriorProposal: () => proposalAttempted,
      },
    },
  };
}

function parseGoal(value: unknown): DurableGoal {
  const fact = { type: 'goal_changed', version: 1, goal: value };
  validateSessionFact(fact);
  const goal = value as DurableGoal;
  const keys = ['id', 'outcome', 'successCriteria', 'status'];
  if (Object.keys(goal).some((key) => !keys.includes(key))) throw new Error('Invalid goal');
  return { ...goal };
}

function parseRevision(value: unknown): GoalRevision {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 2 ||
    typeof (value as SessionEventReference).logId !== 'string' ||
    typeof (value as SessionEventReference).eventId !== 'string'
  )
    throw new Error('Invalid goal revision');
  return { logId: (value as SessionEventReference).logId, eventId: (value as SessionEventReference).eventId };
}

function sameRevision(left: GoalRevision, right: GoalRevision): boolean {
  return left === null || right === null
    ? left === right
    : left.logId === right.logId && left.eventId === right.eventId;
}
