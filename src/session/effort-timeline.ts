/**
 * Cache-preserving effort changes for one root turn's model history.
 *
 * Each turn's selected effort is already durable in its `turn_started`
 * `requestConfiguration`. When the selected model declares an in-conversation
 * effort item (`model/effort-updates.ts`), the turn keeps the request's
 * top-level effort at the value the conversation's first surviving turn used
 * and an `effort_update` marker precedes each later turn whose effort differs
 * from the one before it. Like a recorded notice, the markers are model-only:
 * they are derived again from the log for every turn and after resume, so the
 * prefix a provider has cached is rebuilt byte for byte, and the continuity
 * envelope (which includes the top-level effort) no longer changes, so a
 * chained Responses conversation keeps its anchor.
 *
 * Anything this cannot express exactly returns `undefined`, which keeps
 * today's request: an unsupported model or level, a default (`null`) effort,
 * or a turn whose effort cannot be placed before one of its own items.
 */
import type { Item, ModelRef, ModelRegistry, ReasoningEffort } from '../model/index.js';
import { effortUpdateItem, effortUpdateLevels, isEffortUpdateItem } from '../model/effort-updates.js';
import type { Fact } from './facts.js';

export type EffortTimelinePlan = {
  readonly history: readonly Item[];
  readonly newItems: readonly Item[];
  readonly reasoning: ReasoningEffort;
};

export function planEffortTimeline(input: {
  readonly facts: readonly Fact[];
  readonly history: readonly Item[];
  readonly newItems: readonly Item[];
  readonly model: ModelRef;
  readonly reasoning: ReasoningEffort | undefined;
  readonly levels: readonly ReasoningEffort[] | undefined;
}): EffortTimelinePlan | undefined {
  const { facts, history, newItems, model, reasoning, levels } = input;
  if (!levels || !reasoning || !levels.includes(reasoning)) return undefined;
  // Item id -> [turn, effort] for this model's configured turns, first item of each.
  const starts = new Map<string, { readonly turnId: string; readonly effort: string | null }>();
  const owned = new Map<string, string>();
  for (const fact of facts) {
    if (fact.type !== 'turn_started' || !fact.requestConfiguration) continue;
    const configuration = fact.requestConfiguration;
    if (configuration.provider !== model.provider || configuration.model !== model.model) continue;
    for (const item of fact.input) owned.set(item.id, fact.turnId);
    starts.set(fact.turnId, { turnId: fact.turnId, effort: configuration.reasoningEffort });
  }
  const combined = [...history, ...newItems];
  if (combined.some(isEffortUpdateItem)) return undefined;
  const placed: Item[] = [];
  const seen = new Set<string>();
  let current: string | null | undefined;
  let baseline: string | undefined;
  let historyLength = history.length;
  let changed = false;
  for (const [index, item] of combined.entries()) {
    const turnId = owned.get(item.id);
    if (turnId !== undefined && !seen.has(turnId)) {
      seen.add(turnId);
      const effort = starts.get(turnId)!.effort;
      if (effort === null || !levels.includes(effort as ReasoningEffort)) return undefined;
      if (current === undefined) baseline = current = effort;
      else if (effort !== current) {
        placed.push(effortUpdateItem(`effort-update:${turnId}`, model.provider, effort as ReasoningEffort));
        if (index < history.length) historyLength++;
        current = effort;
        changed = true;
      }
    }
    placed.push(item);
  }
  // The running turn is recorded with the effort it was admitted at; anything else is not ours to rewrite.
  if (!changed || current !== reasoning || baseline === undefined) return undefined;
  return {
    history: placed.slice(0, historyLength),
    newItems: placed.slice(historyLength),
    reasoning: baseline as ReasoningEffort,
  };
}

/** The turn's history, new items and top-level effort, decorated where the model supports it. */
export function effortTimelineForTurn(input: {
  readonly facts: readonly Fact[];
  readonly history: readonly Item[];
  readonly newItems: readonly Item[];
  readonly model: ModelRef | undefined;
  readonly reasoning: ReasoningEffort | undefined;
  readonly models: ModelRegistry;
}): { readonly history: readonly Item[]; readonly newItems: readonly Item[]; readonly reasoning?: ReasoningEffort } {
  const unchanged = {
    history: input.history,
    newItems: input.newItems,
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
  };
  if (!input.model || !input.reasoning) return unchanged;
  let levels: readonly ReasoningEffort[] | undefined;
  try {
    levels = effortUpdateLevels(input.models.resolve(input.model));
  } catch {
    return unchanged;
  }
  return planEffortTimeline({ ...input, model: input.model, levels }) ?? unchanged;
}
