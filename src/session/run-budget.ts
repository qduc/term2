/** Session-owned logical-run clocks and stable physical-request tree accounting. */
import type { TurnDeps, TurnId } from '../engine/index.js';
import { RunBudget, clampRunBudgetPolicy, type ModelRequestCost } from './recovery-budget.js';
import type { DirectTaskState } from './background-types.js';
import type { DirectRequestCostFact, Fact } from './facts.js';

type BudgetOptions = NonNullable<TurnDeps['budget']>;
type Run = {
  readonly rootTurnId: TurnId;
  readonly parentTurnId?: TurnId;
  readonly policy: BudgetOptions['policy'];
  readonly options: BudgetOptions;
  readonly state: RunClock;
};

/** Engine-owned and descendant-human waits may overlap; neither may resume the other's clock. */
class RunClock extends RunBudget {
  #enginePaused = false;
  #descendantWaiting = false;

  override pause(now = Date.now()): void {
    this.#enginePaused = true;
    super.pause(now);
  }

  override resume(now = Date.now()): void {
    this.#enginePaused = false;
    if (!this.#descendantWaiting) super.resume(now);
  }

  descendantWaiting(waiting: boolean): void {
    this.#descendantWaiting = waiting;
    if (waiting) super.pause();
    else if (!this.#enginePaused) super.resume();
  }
}

/**
 * A root gets a new budget; children inherit only the parent's remaining finite envelope.
 * This class never writes the log: a turn's reader builds each cost fact with `costFact` from the engine's
 * `request_cost` event, and every committed cost fact comes back through `retain`.
 */
export class DirectRunBudgets {
  readonly #runs = new Map<TurnId, Run>();
  readonly #costs = new Map<string, DirectRequestCostFact>();

  constructor(readonly options: TurnDeps['budget'], facts: readonly Fact[]) {
    for (const fact of facts) if (fact.type === 'request_cost_recorded') this.retain(fact);
  }

  open(turnId: TurnId, parentTurnId?: TurnId, options = this.options): BudgetOptions | undefined {
    if (!options) return undefined;
    if (this.#runs.has(turnId)) throw new Error('Run budget already exists for this turn');
    const parent = parentTurnId ? this.#runs.get(parentTurnId) : undefined;
    if (parentTurnId && !parent) throw new Error('Child run has no Session-owned parent budget');
    const policy = parent
      ? clampRunBudgetPolicy(options.policy, this.#remaining(parentTurnId!, parent))
      : options.policy;
    const run: Run = {
      rootTurnId: parent?.rootTurnId ?? turnId,
      ...(parentTurnId ? { parentTurnId } : {}),
      policy,
      state: new RunClock(policy),
      options,
    };
    this.#runs.set(turnId, run);
    return {
      ...options,
      policy,
      state: run.state,
      ...(parent ? { wrapUpOnCritical: true } : {}),
      costRecords: (id) => this.records(id),
    };
  }

  /** The fact a reader commits for one of this run's `request_cost` events. Builds it; never writes it. */
  costFact(turnId: TurnId, record: ModelRequestCost): DirectRequestCostFact {
    const run = this.#runs.get(turnId);
    if (!run) throw new Error('Physical request cost has no Session-owned run budget');
    const shared = run.options.costRecords?.(turnId).find((entry) => entry.requestId === record.requestId);
    const fact: DirectRequestCostFact = {
      type: 'request_cost_recorded',
      turnId,
      rootTurnId: run.rootTurnId,
      ...(run.parentTurnId ? { parentTurnId: run.parentTurnId } : {}),
      record: structuredClone(mergeCost(record, shared)),
    };
    this.#assertOwnership(fact);
    return fact;
  }

  /** Count a committed cost fact (replayed or just accepted) toward its run and every ancestor. */
  retain(fact: DirectRequestCostFact): void {
    this.#assertOwnership(fact);
    this.#costs.set(fact.record.requestId, fact);
  }

  /** Descendant costs count once for each ancestor, never against an unrelated root. */
  records(turnId: TurnId): readonly ModelRequestCost[] {
    const source = this.#runs.get(turnId)?.options ?? this.options;
    const records = new Map(source?.costRecords?.(turnId).map((record) => [record.requestId, record]));
    for (const fact of this.#costs.values()) {
      if (fact.turnId !== turnId && !this.#ancestor(fact.turnId, turnId, fact)) continue;
      records.set(fact.record.requestId, mergeCost(fact.record, records.get(fact.record.requestId)));
    }
    return [...records.values()];
  }

  /** Pause ancestors only while a foreground descendant actually awaits a human. */
  taskWaits(tasks: readonly DirectTaskState[]): void {
    const waiting = new Set<TurnId>();
    for (const task of tasks) {
      if (task.mode !== 'foreground' || task.pendingInteractions.length === 0) continue;
      let parent: TurnId | undefined = task.parentTurnId;
      while (parent) {
        waiting.add(parent);
        parent = this.#runs.get(parent)?.parentTurnId;
      }
    }
    for (const [turnId, run] of this.#runs) run.state.descendantWaiting(waiting.has(turnId));
  }

  #remaining(turnId: TurnId, run: Run): BudgetOptions['policy'] {
    // Include costs since the engine's last boundary without consuming its stage
    // latches. The disposable accounting clock never drives or admits work.
    const now = Date.now();
    const snapshot = run.state.snapshot(now);
    const remaining = run.state.remainingPolicy(now);
    // Rebase the disposable clock on the actual unspent (extension-aware)
    // envelope plus already observed usage. If a dimension is already exhausted,
    // the final clamp keeps it at zero; no overdraw or correction grants headroom.
    const accounting = new RunBudget(
      {
        ...run.policy,
        maxUsdMicros: remaining.maxUsdMicros + snapshot.pricedUsdMicros,
        maxUnpricedTokens: remaining.maxUnpricedTokens + snapshot.unpricedTokens,
        maxActiveTimeMs: remaining.maxActiveTimeMs + snapshot.activeTimeMs,
        turnBackstop: remaining.turnBackstop + snapshot.turns,
      },
      now,
    );
    accounting.pause(now);
    const ownRequests = [...this.#costs.values()].filter((fact) => fact.turnId === turnId).length;
    accounting.evaluate({ turns: Math.max(snapshot.turns, ownRequests), costRecords: this.records(turnId) });
    return clampRunBudgetPolicy(accounting.remainingPolicy(now), remaining);
  }

  #ancestor(turnId: TurnId, ancestor: TurnId, fact: DirectRequestCostFact): boolean {
    if (fact.rootTurnId === ancestor) return true;
    let parent = this.#runs.get(turnId)?.parentTurnId ?? fact.parentTurnId;
    while (parent) {
      if (parent === ancestor) return true;
      parent = this.#runs.get(parent)?.parentTurnId;
    }
    return false;
  }

  #assertOwnership(fact: DirectRequestCostFact): void {
    const existing = this.#costs.get(fact.record.requestId);
    if (
      existing &&
      (existing.turnId !== fact.turnId ||
        existing.rootTurnId !== fact.rootTurnId ||
        existing.parentTurnId !== fact.parentTurnId)
    )
      throw new Error('Physical request cost identity changed run ownership');
  }
}

function mergeCost(record: ModelRequestCost, shared?: ModelRequestCost): ModelRequestCost {
  if (!shared || record.source === 'provider') return record;
  return { ...record, ...shared, outcome: record.outcome, usage: record.usage ?? shared.usage };
}
