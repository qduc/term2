import type { ModelRequestCost } from '../cost/model-cost.js';
import { isSubscriptionProvider } from '../cost/subscription-providers.js';

/** Settings-backed containment policy for one logical agent run. */
export interface RunBudgetPolicy {
  readonly maxUsdMicros: number;
  readonly maxUnpricedTokens: number;
  readonly maxActiveTimeMs: number;
  readonly warningHeadroomUsdMicros: number;
  readonly warningHeadroomUnpricedTokens: number;
  readonly warningHeadroomActiveTimeMs: number;
  readonly softHeadroomUsdMicros: number;
  readonly softHeadroomUnpricedTokens: number;
  readonly softHeadroomActiveTimeMs: number;
  readonly turnBackstop: number;
  readonly extensionPercent: number;
  readonly maxParentExtensions: number;
  readonly identicalToolCallThreshold: number;
  /**
   * What a non-soft stage does.
   *
   * `warn` reports evidence and lets the run continue; `pause` holds the run at
   * a request boundary for a human decision. Warning is the default because a
   * budget that cannot price the request is a rough proxy, and stopping real
   * work on a proxy is a worse failure than overrunning it.
   */
  readonly escalation: 'warn' | 'pause';
}

interface RunBudgetSettingsReader {
  get(key: any): any;
}

/** Read the leaf-keyed settings API into the runtime policy contract. */
export function readRunBudgetPolicy(settings: RunBudgetSettingsReader): RunBudgetPolicy {
  return {
    maxUsdMicros: settings.get('agent.runBudget.maxUsdMicros'),
    maxUnpricedTokens: settings.get('agent.runBudget.maxUnpricedTokens'),
    maxActiveTimeMs: settings.get('agent.runBudget.maxActiveTimeMs'),
    warningHeadroomUsdMicros: settings.get('agent.runBudget.warningHeadroomUsdMicros'),
    warningHeadroomUnpricedTokens: settings.get('agent.runBudget.warningHeadroomUnpricedTokens'),
    warningHeadroomActiveTimeMs: settings.get('agent.runBudget.warningHeadroomActiveTimeMs'),
    softHeadroomUsdMicros: settings.get('agent.runBudget.softHeadroomUsdMicros'),
    softHeadroomUnpricedTokens: settings.get('agent.runBudget.softHeadroomUnpricedTokens'),
    softHeadroomActiveTimeMs: settings.get('agent.runBudget.softHeadroomActiveTimeMs'),
    turnBackstop: settings.get('agent.runBudget.turnBackstop'),
    extensionPercent: settings.get('agent.runBudget.extensionPercent'),
    maxParentExtensions: settings.get('agent.runBudget.maxParentExtensions'),
    identicalToolCallThreshold: settings.get('agent.runBudget.identicalToolCallThreshold'),
    escalation: settings.get('agent.runBudget.escalation') ?? 'warn',
  };
}

/**
 * Clamp a child's envelope to what the parent has left.
 *
 * `resolveLimits` does this for `AgentLimits`; the staged dimensions are read
 * from process settings, so without this every child of every depth would start
 * with the full settings envelope no matter how much the parent had spent. The
 * containment this restores is per-child: N siblings can still sum past the
 * parent's remainder, which is the tree-aggregate job `ExecutionBudget` owns.
 */
export function clampRunBudgetPolicy(child: RunBudgetPolicy, parent?: RunBudgetPolicy): RunBudgetPolicy {
  if (!parent) return child;
  return {
    ...child,
    maxUsdMicros: Math.min(child.maxUsdMicros, parent.maxUsdMicros),
    maxUnpricedTokens: Math.min(child.maxUnpricedTokens, parent.maxUnpricedTokens),
    maxActiveTimeMs: Math.min(child.maxActiveTimeMs, parent.maxActiveTimeMs),
    turnBackstop: Math.min(child.turnBackstop, parent.turnBackstop),
    maxParentExtensions: Math.min(child.maxParentExtensions, parent.maxParentExtensions),
  };
}

export type RunBudgetStage = 'soft' | 'warning' | 'critical';
export type RunBudgetDimension = 'usd' | 'unpriced_tokens' | 'active_time' | 'turns';

export interface RunBudgetEvidence {
  readonly dimension: RunBudgetDimension;
  readonly used: number;
  readonly limit: number;
  readonly headroom: number;
}

export type RunBudgetEvent =
  | { readonly type: 'budget_stage'; readonly stage: RunBudgetStage; readonly evidence: RunBudgetEvidence }
  | {
      readonly type: 'tool_stall';
      readonly toolName: string;
      readonly argumentsText: string;
      readonly count: number;
      readonly threshold: number;
    };

/**
 * Synthetic interruption used to park a main-agent run at a request boundary.
 * It travels through the established continuation path but is not a tool call.
 */
export type RunBudgetInteraction = {
  readonly type: 'run_budget_interaction';
  readonly event: RunBudgetEvent;
};

export function isRunBudgetInteraction(value: unknown): value is RunBudgetInteraction {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'run_budget_interaction' &&
    'event' in value
  );
}

export interface RunBudgetSnapshot {
  readonly pricedUsdMicros: number;
  readonly unpricedTokens: number;
  readonly activeTimeMs: number;
  readonly turns: number;
  readonly extensionsGranted: number;
  readonly latchedStages: readonly RunBudgetStage[];
}

export interface ToolStallObservation {
  readonly name: string;
  /** The exact provider argument bytes, intentionally not normalized. */
  readonly argumentsText: string;
  readonly effect?: 'mutating';
}

/**
 * Stateful per-run budget and deterministic tool-stall sensor.
 *
 * This class deliberately emits evidence rather than making a decision about
 * whether to stop a run. Its clock is active only while a segment executes;
 * continuations resume it after approval waits.
 */
export class RunBudget {
  readonly #policy: RunBudgetPolicy;
  #activeSince: number | undefined;
  #activeTimeMs = 0;
  #pricedUsdMicros = 0;
  #unpricedTokens = 0;
  #turns = 0;
  #extensionsGranted = 0;
  #parentExtensionsGranted = 0;
  #latchedStages = new Set<RunBudgetStage>();
  #stallCounts = new Map<string, number>();
  #latchedStalls = new Set<string>();
  #softEvidence: RunBudgetEvidence | undefined;
  #pendingStallEvidence: Extract<RunBudgetEvent, { type: 'tool_stall' }> | undefined;

  constructor(policy: RunBudgetPolicy, now = Date.now()) {
    this.#policy = policy;
    this.#activeSince = now;
  }

  resume(now = Date.now()): void {
    if (this.#activeSince === undefined) this.#activeSince = now;
  }

  pause(now = Date.now()): void {
    if (this.#activeSince === undefined) return;
    this.#activeTimeMs += Math.max(0, now - this.#activeSince);
    this.#activeSince = undefined;
  }

  evaluate(input: { now?: number; turns: number; costRecords: readonly ModelRequestCost[] }): RunBudgetEvent[] {
    const now = input.now ?? Date.now();
    const activeTimeMs = this.#currentActiveTime(now);
    this.#turns = input.turns;
    this.#pricedUsdMicros = input.costRecords.reduce(
      (total, record) => total + (Number.isFinite(record.usdMicros) ? record.usdMicros! : 0),
      0,
    );
    this.#unpricedTokens = input.costRecords.reduce(
      (total, record) =>
        total + (record.usdMicros === undefined && !isSubscriptionProvider(record.provider) ? totalTokens(record) : 0),
      0,
    );

    const limits = this.#limits();
    const byDimension: Array<{
      dimension: RunBudgetDimension;
      used: number;
      limit: number;
      soft: number;
      warning: number;
    }> = [
      {
        dimension: 'usd',
        used: this.#pricedUsdMicros,
        limit: limits.maxUsdMicros,
        soft: this.#policy.softHeadroomUsdMicros,
        warning: this.#policy.warningHeadroomUsdMicros,
      },
      {
        dimension: 'unpriced_tokens',
        used: this.#unpricedTokens,
        limit: limits.maxUnpricedTokens,
        soft: this.#policy.softHeadroomUnpricedTokens,
        warning: this.#policy.warningHeadroomUnpricedTokens,
      },
      {
        dimension: 'active_time',
        used: activeTimeMs,
        limit: limits.maxActiveTimeMs,
        soft: this.#policy.softHeadroomActiveTimeMs,
        warning: this.#policy.warningHeadroomActiveTimeMs,
      },
    ];
    const events: RunBudgetEvent[] = [];
    for (const stage of ['soft', 'warning', 'critical'] as const) {
      if (this.#latchedStages.has(stage)) continue;
      const candidates = byDimension.filter(({ used, limit, soft, warning }) => {
        const headroom = limit - used;
        return stage === 'soft' ? headroom <= soft : stage === 'warning' ? headroom <= warning : headroom <= 0;
      });
      if (stage === 'critical' && this.#turns > limits.turnBackstop) {
        candidates.push({ dimension: 'turns', used: this.#turns, limit: limits.turnBackstop, soft: 0, warning: 0 });
      }
      if (candidates.length === 0) continue;
      const chosen = closestToExhausted(candidates);
      const evidence: RunBudgetEvidence = {
        dimension: chosen.dimension,
        used: chosen.used,
        limit: chosen.limit,
        headroom: chosen.limit - chosen.used,
      };
      this.#latchedStages.add(stage);
      if (stage === 'soft') this.#softEvidence = evidence;
      events.push({ type: 'budget_stage', stage, evidence });
    }
    return events;
  }

  get softEvidence(): RunBudgetEvidence | undefined {
    return this.#softEvidence;
  }

  /** Returns the one pending soft-stage nudge for the next tool result. */
  takeSoftEvidence(): RunBudgetEvidence | undefined {
    const evidence = this.#softEvidence;
    this.#softEvidence = undefined;
    return evidence;
  }

  /**
   * Grant one finite extension.
   *
   * `maxParentExtensions` caps grants that arrive without a human — a parent
   * agent judging a child, or an unattended continuation. A human answering a
   * blocking prompt is the terminal judge and is not capped: the plan routes
   * the grant past the parent to them precisely because the cap has run out,
   * and each human grant already costs a fresh prompt.
   */
  grantExtension(grantedBy: 'parent' | 'human' = 'parent'): { granted: boolean; extensionsGranted: number } {
    if (grantedBy === 'parent' && this.#parentExtensionsGranted >= this.#policy.maxParentExtensions) {
      return { granted: false, extensionsGranted: this.#extensionsGranted };
    }
    if (grantedBy === 'parent') this.#parentExtensionsGranted += 1;
    this.#extensionsGranted += 1;
    // Critical is latched per finite envelope. A larger envelope must be able
    // to reach its own critical boundary and ask again; otherwise the second
    // extension would quietly become unlimited work.
    this.#latchedStages.delete('critical');
    return { granted: true, extensionsGranted: this.#extensionsGranted };
  }

  observeToolCall(observation: ToolStallObservation): RunBudgetEvent | undefined {
    if (observation.effect === 'mutating') {
      this.#stallCounts.clear();
      this.#latchedStalls.clear();
      return undefined;
    }
    const key = `${observation.name}\u0000${observation.argumentsText}`;
    const count = (this.#stallCounts.get(key) ?? 0) + 1;
    this.#stallCounts.set(key, count);
    // Re-arm every further threshold rather than latching once. The run itself
    // is the nearest judge and the only one that can act mid-stream; telling it
    // once and then going quiet lets a loop run to the envelope's end in
    // silence. The parent's copy stays exact-once, deduplicated below.
    if (count === 0 || count % this.#policy.identicalToolCallThreshold !== 0) return undefined;
    const event = {
      type: 'tool_stall',
      toolName: observation.name,
      argumentsText: observation.argumentsText,
      count,
      threshold: this.#policy.identicalToolCallThreshold,
    } as const;
    // Sensation for the run: delivered on its next tool result, every time.
    this.#pendingStallEvidence = event;
    if (this.#latchedStalls.has(key)) return undefined;
    this.#latchedStalls.add(key);
    return event;
  }

  /** Returns the pending stall notice for this run's next tool result. */
  takeStallEvidence(): Extract<RunBudgetEvent, { type: 'tool_stall' }> | undefined {
    const evidence = this.#pendingStallEvidence;
    this.#pendingStallEvidence = undefined;
    return evidence;
  }

  /**
   * This run's envelope expressed as what is still unspent, for clamping a
   * child. Thresholds carry over unchanged: they describe what counts as
   * alarming, not how much room exists.
   */
  remainingPolicy(now = Date.now()): RunBudgetPolicy {
    const limits = this.#limits();
    return {
      ...this.#policy,
      maxUsdMicros: Math.max(0, limits.maxUsdMicros - this.#pricedUsdMicros),
      maxUnpricedTokens: Math.max(0, limits.maxUnpricedTokens - this.#unpricedTokens),
      maxActiveTimeMs: Math.max(0, limits.maxActiveTimeMs - this.#currentActiveTime(now)),
      turnBackstop: Math.max(0, limits.turnBackstop - this.#turns),
    };
  }

  snapshot(now = Date.now()): RunBudgetSnapshot {
    return {
      pricedUsdMicros: this.#pricedUsdMicros,
      unpricedTokens: this.#unpricedTokens,
      activeTimeMs: this.#currentActiveTime(now),
      turns: this.#turns,
      extensionsGranted: this.#extensionsGranted,
      latchedStages: [...this.#latchedStages],
    };
  }

  #limits(): Pick<RunBudgetPolicy, 'maxUsdMicros' | 'maxUnpricedTokens' | 'maxActiveTimeMs' | 'turnBackstop'> {
    const multiplier = 1 + (this.#extensionsGranted * this.#policy.extensionPercent) / 100;
    return {
      maxUsdMicros: Math.ceil(this.#policy.maxUsdMicros * multiplier),
      maxUnpricedTokens: Math.ceil(this.#policy.maxUnpricedTokens * multiplier),
      maxActiveTimeMs: Math.ceil(this.#policy.maxActiveTimeMs * multiplier),
      turnBackstop: Math.ceil(this.#policy.turnBackstop * multiplier),
    };
  }

  #currentActiveTime(now: number): number {
    return this.#activeTimeMs + (this.#activeSince === undefined ? 0 : Math.max(0, now - this.#activeSince));
  }
}

/**
 * What a cache-read token counts for against the unpriced-token budget.
 *
 * The budget stands in for money on requests that carry no price, and a cache
 * read is roughly an order of magnitude cheaper than fresh input everywhere it
 * is priced at all. Counting it at face value made a heavily cached session —
 * the cheap case — exhaust the envelope fastest, which is backwards.
 */
const CACHED_TOKEN_WEIGHT = 0.1;

function totalTokens(record: ModelRequestCost): number {
  const usage = record.usage;
  if (!usage) return 0;
  const cacheReadTokens = usage.cache_read_tokens ?? 0;
  const total = Number.isFinite(usage.total_tokens)
    ? usage.total_tokens!
    : (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) + (usage.cache_creation_tokens ?? 0);
  // Cache reads are reported inside the prompt/total counts, so discount them
  // rather than adding a separate weighted term.
  return Math.max(0, Math.round(total - cacheReadTokens * (1 - CACHED_TOKEN_WEIGHT)));
}

function closestToExhausted<T extends { used: number; limit: number }>(candidates: readonly T[]): T {
  return candidates.reduce((closest, candidate) =>
    candidate.limit === 0 || candidate.used / candidate.limit > closest.used / closest.limit ? candidate : closest,
  );
}
