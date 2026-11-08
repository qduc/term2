/** Run-local accounting and non-tool check-ins; Session owns durable decisions. */
import type { Item, ItemId, ModelRef, Usage } from '../model/index.js';
import type { InteractionRequestId } from '../tools/contracts.js';
import type { BudgetDecision, TurnDeps, TurnSpec } from './types.js';
import { directBudgetAction, RunBudget, type ModelRequestCost, type RunBudgetEvent } from './recovery-budget.js';
import { computeModelCost } from '../shared/cost/model-cost.js';
import { TurnEvents, cancelled } from './turn-events.js';

/** Native branch admission is exhausted, not a provider failure or successful completion. */
export class NativeBudgetExhausted extends Error {}

type Pending = { ready: boolean; resolve(value: BudgetDecision): void; reject(error: Error): void };

function recordValue(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Billing tier of the request as dispatched. A request that did not ask for a
 * non-standard tier is standard; an unrecognized explicit tier fails closed so
 * it is never priced at another tier's rate.
 */
export function serviceTierForRequest(request: {
  readonly useStandardServiceTier?: boolean;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}): ModelRequestCost['serviceTier'] {
  if (request.useStandardServiceTier) return 'standard';
  const options = request.providerOptions;
  const raw = options?.service_tier ?? recordValue(options?.extraBody, 'service_tier');
  if (raw === undefined || raw === 'default' || raw === 'standard') return 'standard';
  if (raw === 'flex' || raw === 'batch') return raw;
  return 'unknown';
}

export class TurnBudgetControl<AppCtx = unknown> {
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
    readonly deps: TurnDeps<AppCtx>,
    readonly events: TurnEvents,
    readonly signal: AbortSignal,
  ) {
    this.state =
      deps.budget?.state ??
      (deps.budget
        ? new RunBudget(deps.budget.policy, Date.now(), deps.accounting?.isSubscriptionProvider)
        : undefined);
    this.state?.resume();
  }

  /** The caller must only forward a decision whose matching Session fact committed. */
  answer(id: InteractionRequestId, decision: BudgetDecision): void {
    const pending = this.#pending.get(id);
    if (!pending?.ready || this.signal.aborted) return;
    this.#pending.delete(id);
    pending.resolve(decision);
  }

  /** Stable per-physical-request records survive failures and history compaction.
   * Model cached input is normalized as cache-read tokens, not extra prompt tokens.
   * A budgeted run hands the record to Session as a `request_cost` event and waits for it to be accepted,
   * so the cost fact lands in the log in emission order (issue #199). */
  async record(input: {
    requestId: string;
    model: ModelRef;
    usage?: Usage;
    costUsd?: number | string;
    outcome: ModelRequestCost['outcome'];
    serviceTier?: ModelRequestCost['serviceTier'];
  }): Promise<void> {
    const serviceTier = input.serviceTier ?? 'standard';
    // Subscriptions have no per-token rate to look up. A provider-reported
    // charge still wins; otherwise the request stays unpriced instead of
    // inventing a Codex/Grok dollar amount from catalog rates.
    const subscription = this.deps.accounting?.isSubscriptionProvider?.(input.model.provider) ?? false;
    const record = computeModelCost({
      requestId: input.requestId,
      provider: input.model.provider,
      model: input.model.model,
      serviceTier,
      outcome: input.outcome,
      ...(input.usage
        ? {
            usage: {
              prompt_tokens: input.usage.inputTokens,
              completion_tokens: input.usage.outputTokens,
              cache_read_tokens: input.usage.cachedInputTokens,
              total_tokens: input.usage.inputTokens + input.usage.outputTokens,
            },
          }
        : {}),
      ...(input.costUsd !== undefined ? { providerUsd: input.costUsd } : {}),
      getPrice: subscription
        ? () => ({ found: false, reason: 'unknown_provider' })
        : this.deps.accounting?.getPrice ?? (() => ({ found: false, reason: 'unknown_provider' })),
      pricingVersion: this.deps.accounting?.getPricingVersion?.(serviceTier),
    });
    this.#costs.set(input.requestId, record);
    if (!this.deps.budget) return;
    // Rejects only when this wait is cancelled; the event stays queued as cleanup and Session still records it.
    await this.events.publish({ type: 'request_cost', record }).catch(() => {});
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
    this.deps.onTurnBoundary?.({ turnId: this.spec.turnId, kind: 'parked' });
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
    const costs = new Map(this.deps.budget.costRecords?.(this.spec.turnId).map((cost) => [cost.requestId, cost]));
    for (const [id, cost] of this.#costs) {
      const shared = costs.get(id);
      // Actual provider charges win; otherwise retain a price supplied by the
      // owning catalog/accounting capability instead of erasing it as unknown.
      costs.set(
        id,
        !shared || cost.source === 'provider'
          ? cost
          : { ...cost, ...shared, outcome: cost.outcome, usage: cost.usage ?? shared.usage },
      );
    }
    const observations = [
      ...this.#observations.splice(0),
      // Count the request about to be dispatched, as the legacy loop did: a backstop of N admits N requests, not N + 1.
      ...this.state.evaluate({ turns: this.#turns + 1, costRecords: [...costs.values()] }),
    ];
    const stall = this.state.takeStallEvidence();
    if (
      stall &&
      !observations.some(
        (event) =>
          event.type === 'tool_stall' &&
          event.toolName === stall.toolName &&
          event.argumentsText === stall.argumentsText &&
          event.count === stall.count,
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
      // A finite grant may still be smaller than the measured overrun. Never
      // treat its existence as permission for an already-exhausted dispatch.
      return this.beforeRequest(history);
    }
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
