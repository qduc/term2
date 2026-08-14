import type { ModelRequestCost } from '../cost/model-cost.js';

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
  #latchedStages = new Set<RunBudgetStage>();
  #stallCounts = new Map<string, number>();
  #latchedStalls = new Set<string>();
  #softEvidence: RunBudgetEvidence | undefined;

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
      (total, record) => total + (record.usdMicros === undefined ? totalTokens(record) : 0),
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

  grantExtension(): { granted: boolean; extensionsGranted: number } {
    if (this.#extensionsGranted >= this.#policy.maxParentExtensions) {
      return { granted: false, extensionsGranted: this.#extensionsGranted };
    }
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
    if (count !== this.#policy.identicalToolCallThreshold || this.#latchedStalls.has(key)) return undefined;
    this.#latchedStalls.add(key);
    return {
      type: 'tool_stall',
      toolName: observation.name,
      argumentsText: observation.argumentsText,
      count,
      threshold: this.#policy.identicalToolCallThreshold,
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

function totalTokens(record: ModelRequestCost): number {
  const usage = record.usage;
  if (!usage) return 0;
  if (Number.isFinite(usage.total_tokens)) return usage.total_tokens!;
  return (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) + (usage.cache_creation_tokens ?? 0);
}

function closestToExhausted<T extends { used: number; limit: number }>(candidates: readonly T[]): T {
  return candidates.reduce((closest, candidate) =>
    candidate.limit === 0 || candidate.used / candidate.limit > closest.used / closest.limit ? candidate : closest,
  );
}
