/** Owns task/branch audit streams and physical-request accounting across root rotations. */
import type { TurnId } from '../engine/index.js';
import type { Fact, DirectTurnFact } from './facts.js';
import type { DirectBackgroundFact } from './direct-background-types.js';
import { projectDirectBackground } from './direct-background-replay.js';
import type { ReplayedConversation, ReplayedBranch } from './replay.js';

type RequestCost = Extract<Fact, { type: 'request_cost_recorded' }>;
type BranchStream = {
  readonly taskId: string;
  readonly turnId: TurnId;
  readonly parentTurnId?: TurnId;
  readonly rootTurnId?: TurnId;
  readonly facts: (Extract<Fact, { type: 'turn_started' }> | Extract<Fact, { type: 'branch_event' }>['fact'])[];
};

export class ReplayBackground {
  private readonly backgroundFacts: DirectBackgroundFact[] = [];
  private readonly branches = new Map<string, BranchStream>();
  // Accounting outlives transcript replacements/terminals. Only ownership is immutable;
  // a later physical receipt may correct or enrich the same request's record.
  private readonly requestCosts = new Map<string, RequestCost>();

  /** Consume audit-only facts; false leaves root lifecycle validation to replay. */
  accept(fact: Fact): boolean {
    if (
      [
        'task_started',
        'task_backgrounded',
        'task_stop_requested',
        'task_finished',
        'task_interaction_opened',
        'task_interaction_closed',
        'task_question_opened',
        'task_question_closed',
      ].includes(fact.type)
    ) {
      // Task projection rejects invalid transitions; no live continuations are restored.
      this.backgroundFacts.push(fact as DirectBackgroundFact);
      return true;
    }
    switch (fact.type) {
      case 'request_cost_recorded': {
        const previous = this.requestCosts.get(fact.record.requestId);
        if (
          previous &&
          (previous.turnId !== fact.turnId ||
            previous.rootTurnId !== fact.rootTurnId ||
            previous.parentTurnId !== fact.parentTurnId)
        )
          throw new Error(`replay: request cost ownership changed for ${fact.record.requestId}`);
        for (const branch of this.branches.values())
          if (branch.turnId === fact.turnId) validateCostAncestry(fact, branch);
        this.requestCosts.set(fact.record.requestId, fact);
        // No requireActive: summary/failure/cancel receipts can arrive after a root
        // terminal. Costs are not model-output receipts, usage events or Items.
        break;
      }
      case 'branch_started':
        if (this.branches.has(fact.branchId)) throw new Error('replay: duplicate branch ID');
        {
          // The latest start owns the branch; a continued run's earlier epochs have settled.
          let start = this.backgroundFacts.length - 1;
          for (; start >= 0; start--) {
            const item = this.backgroundFacts[start]!;
            if (item.type === 'task_started' && item.task.taskId === fact.taskId) break;
          }
          if (
            start < 0 ||
            this.backgroundFacts
              .slice(start)
              .some((item) => item.type === 'task_finished' && item.taskId === fact.taskId)
          )
            throw new Error('replay: branch has no live task owner');
        }
        for (const cost of this.requestCosts.values())
          if (cost.turnId === fact.turnId) validateCostAncestry(cost, fact);
        this.branches.set(fact.branchId, {
          taskId: fact.taskId,
          turnId: fact.turnId,
          ...(fact.parentTurnId === undefined ? {} : { parentTurnId: fact.parentTurnId }),
          ...(fact.rootTurnId === undefined ? {} : { rootTurnId: fact.rootTurnId }),
          facts: [{ type: 'turn_started', turnId: fact.turnId, input: fact.input }],
        });
        break;
      case 'branch_event': {
        const branch = this.branches.get(fact.branchId);
        if (!branch || fact.fact.turnId !== branch.turnId)
          throw new Error('replay: branch event has no matching branch turn');
        branch.facts.push(fact.fact);
        break;
      }
      default:
        return false;
    }
    return true;
  }

  /** Project branches with the caller's explicit live/reopen recovery policy. */
  project(sessionId: string | undefined, projectBranch: (facts: readonly Fact[]) => ReplayedConversation) {
    const recoveryFacts: Fact[] = [];
    const background = projectDirectBackground(this.backgroundFacts);
    if (sessionId && background.some((task) => task.sessionId !== sessionId))
      throw new Error('replay: task belongs to a different Session');
    const branchViews: ReplayedBranch[] = [];
    for (const [branchId, branch] of this.branches) {
      // Foreground live settlement must never close a still-productive background branch.
      const view = projectBranch(branch.facts);
      branchViews.push({
        branchId,
        taskId: branch.taskId,
        turnId: branch.turnId,
        ...(branch.parentTurnId === undefined ? {} : { parentTurnId: branch.parentTurnId }),
        ...(branch.rootTurnId === undefined ? {} : { rootTurnId: branch.rootTurnId }),
        history: view.history,
        compactions: view.compactions,
        status: view.status,
      });
      if (
        !branch.facts.some((fact) => fact.type === 'turn_ended') &&
        background.some((task) => task.taskId === branch.taskId && task.result)
      )
        throw new Error('replay: task settled before its branch terminal');
      for (const fact of view.recoveryFacts)
        recoveryFacts.push({
          type: 'branch_event',
          branchId,
          fact: fact as Exclude<DirectTurnFact, { type: 'turn_started' | 'interaction_opened' | 'interaction_closed' }>,
        });
    }
    return { background, branches: branchViews, recoveryFacts };
  }
}

/** Older branch records have no ancestry: never infer their root from current foreground activity. */
function validateCostAncestry(
  cost: RequestCost,
  branch: { readonly parentTurnId?: TurnId; readonly rootTurnId?: TurnId },
): void {
  if (
    (branch.parentTurnId !== undefined && branch.parentTurnId !== cost.parentTurnId) ||
    (branch.rootTurnId !== undefined && branch.rootTurnId !== cost.rootTurnId)
  )
    throw new Error(`replay: request cost ancestry disagrees with branch for ${cost.record.requestId}`);
}
