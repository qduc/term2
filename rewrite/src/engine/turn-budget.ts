/** Run-local accounting and non-tool check-ins; Session owns durable decisions. */
import type { Item, ItemId, ModelRef, Usage } from '../model/index.js';
import type { InteractionRequestId } from '../tools/index.js';
import type { BudgetDecision, TurnDeps, TurnSpec } from './direct-types.js';
import { directBudgetAction, RunBudget, type ModelRequestCost, type RunBudgetEvent } from './direct-recovery-budget.js';
import { parseUsdMicros } from '../../../source/services/cost/model-cost.js';
import { TurnEvents, cancelled } from './turn-events.js';

/** Native branch admission is exhausted, not a provider failure or successful completion. */
export class NativeBudgetExhausted extends Error {}

type Pending = { ready: boolean; resolve(value: BudgetDecision): void; reject(error: Error): void };

export class TurnBudgetControl {
  readonly state: RunBudget | undefined;
  readonly #costs = new Map<string, ModelRequestCost>();
  readonly #observations: RunBudgetEvent[] = [];
  readonly #pending = new Map<InteractionRequestId, Pending>();
  #ordinal = 0;
  #turns = 0;
  #waiters = 0;
  #wrapUp = false;
  #wrapUpDispatched = false;

  constructor(
    readonly spec: TurnSpec,
    readonly deps: TurnDeps,
    readonly events: TurnEvents,
    readonly signal: AbortSignal,
  ) {
    this.state = deps.budget?.state ?? (deps.budget ? new RunBudget(deps.budget.policy) : undefined);
    this.state?.resume();
  }

  /** The caller must only forward a decision whose matching Session fact committed. */
  answer(id: InteractionRequestId, decision: BudgetDecision): void {
    const pending = this.#pending.get(id);
    if (!pending?.ready || this.signal.aborted) return;
    this.#pending.delete(id);
    pending.resolve(decision);
  }

  /** Stable per-physical-request records survive failures and history compaction. */
  record(input: {
    requestId: string;
    model: ModelRef;
    usage?: Usage;
    costUsd?: number | string;
    outcome: ModelRequestCost['outcome'];
  }): void {
    const usdMicros = parseUsdMicros(input.costUsd);
    this.#costs.set(input.requestId, {
      requestId: input.requestId,
      provider: input.model.provider,
      model: input.model.model,
      serviceTier: 'unknown',
      outcome: input.outcome,
      ...(input.usage
        ? {
            usage: {
              prompt_tokens: input.usage.inputTokens,
              completion_tokens: input.usage.outputTokens,
              cached_tokens: input.usage.cachedInputTokens,
              total_tokens: input.usage.inputTokens + input.usage.outputTokens,
            },
          }
        : {}),
      ...(usdMicros !== undefined
        ? { usdMicros, source: 'provider' as const }
        : { unpricedReason: input.usage ? ('unknown_model' as const) : ('missing_usage' as const) }),
    });
  }

  get wrappingUp(): boolean {
    return this.#wrapUpDispatched;
  }

  dispatched(wrapUp = false): void {
    if (wrapUp) this.#wrapUpDispatched = true;
    ++this.#turns;
  }

  /** Observe exact executed argument bytes, with explicit mutation evidence only. */
  toolCall(name: string, input: unknown, argumentsText: string): void {
    const evidence = this.state?.observeToolCall({
      name,
      argumentsText,
      effect: this.deps.budget?.toolEffect?.(name, input),
    });
    if (evidence) this.#observations.push(evidence);
  }

  /** Exclude overlapping human waits once, not once per parallel tool. */
  async humanWait<T>(operation: () => Promise<T>): Promise<T> {
    if (++this.#waiters === 1) this.state?.pause();
    try {
      return await operation();
    } finally {
      if (--this.#waiters === 0 && !this.signal.aborted) this.state?.resume();
    }
  }

  /** Only settled boundaries may ask, extend, or enter a final tools-disabled request. */
  async beforeRequest(history: Item[]): Promise<'run' | 'wrap_up' | 'stop'> {
    if (!this.state || !this.deps.budget) return 'run';
    if (this.#wrapUp) return this.#wrapUpDispatched ? 'stop' : 'wrap_up';
    const costs = new Map(this.deps.budget.costRecords?.().map((cost) => [cost.requestId, cost]));
    for (const [id, cost] of this.#costs) costs.set(id, cost);
    const observations = [
      ...this.#observations.splice(0),
      ...this.state.evaluate({ turns: this.#turns, costRecords: [...costs.values()] }),
    ];
    const stall = this.state.takeStallEvidence();
    if (
      stall &&
      !observations.some(
        (event) =>
          event.type === 'tool_stall' &&
          event.toolName === stall.toolName &&
          event.argumentsText === stall.argumentsText,
      )
    )
      observations.push(stall);
    // A single measurement can cross several stages. Report all evidence, but
    // ask only once at the strongest boundary; an extension retires that snapshot.
    let selected: { evidence: RunBudgetEvent; action: 'pause' | 'wrap_up' } | undefined;
    for (const evidence of observations) {
      const action = directBudgetAction({
        policy: this.deps.budget.policy,
        event: evidence,
        wrapUpOnCritical: this.deps.budget.wrapUpOnCritical ?? false,
      });
      await this.events.publish({ type: 'budget_observed', evidence });
      await this.#notice(history, `Run budget evidence: ${JSON.stringify(evidence)}`);
      if (
        action !== 'observe' &&
        (!selected || action === 'wrap_up' || (evidence.type === 'budget_stage' && evidence.stage === 'critical'))
      )
        selected = { evidence, action };
    }
    if (!selected) return 'run';
    if (selected.action === 'wrap_up') {
      this.#wrapUp = true;
      await this.#notice(
        history,
        'The child run budget is exhausted. Give a final truthful wrap-up with no further tools.',
      );
      return 'wrap_up';
    }
    while (true) {
      const decision = await this.humanWait(() => this.#checkIn(selected!.evidence));
      if (decision.kind === 'stop') return 'stop';
      if (decision.kind === 'steer') {
        // Steering does not silently waive an exhausted finite envelope.
        history.push(...decision.items);
        continue;
      }
      if (!this.state.grantExtension(decision.grantedBy).granted) return 'stop';
      break;
    }
    return 'run';
  }

  async #notice(history: Item[], text: string): Promise<void> {
    const item: Item = {
      type: 'summary',
      id: `${this.spec.turnId}:budget-notice:${++this.#ordinal}` as ItemId,
      text,
      replaces: [],
    };
    await this.events.publish({ type: 'item', item });
    history.push(item);
  }

  cancel(): void {
    for (const pending of this.#pending.values()) pending.reject(cancelled());
    this.#pending.clear();
    this.state?.pause();
  }

  async #checkIn(evidence: RunBudgetEvent): Promise<BudgetDecision> {
    const requestId = `${this.spec.turnId}:budget:${++this.#ordinal}` as InteractionRequestId;
    const decision = new Promise<BudgetDecision>((resolve, reject) =>
      this.#pending.set(requestId, { ready: false, resolve, reject }),
    );
    void decision.catch(() => {});
    try {
      await this.events.publish(
        { type: 'budget_required', requestId, turnId: this.spec.turnId, evidence, snapshot: this.state!.snapshot() },
        () => {
          const pending = this.#pending.get(requestId);
          if (pending) pending.ready = true;
        },
      );
      if (this.signal.aborted) throw cancelled();
      return await decision;
    } finally {
      this.#pending.delete(requestId);
    }
  }
}
