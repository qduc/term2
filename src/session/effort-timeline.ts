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
import type { Item, ModelRef, ModelRegistry, ModelRequest, ReasoningEffort } from '../model/index.js';
import {
  EFFORT_UPDATES_REJECTED,
  effortUpdateItem,
  effortUpdateLevels,
  isEffortUpdateItem,
  lastEffortUpdate,
} from '../model/effort-updates.js';
import type { Fact } from './facts.js';

export type EffortTimelinePlan = {
  readonly history: readonly Item[];
  readonly newItems: readonly Item[];
  readonly reasoning: ReasoningEffort;
};

function planEffortTimeline(input: {
  readonly facts: readonly Fact[];
  readonly history: readonly Item[];
  readonly newItems: readonly Item[];
  readonly model: ModelRef;
  readonly reasoning: ReasoningEffort | undefined;
  readonly levels: readonly ReasoningEffort[] | undefined;
}): EffortTimelinePlan | undefined {
  const { facts, history, newItems, model, reasoning, levels } = input;
  if (!levels || !reasoning || !levels.includes(reasoning) || effortUpdatesRejected(facts)) return undefined;
  // Item id -> [turn, effort] for this model's configured turns, first item of each. A compaction,
  // rewind or rollover starts afresh: only turns admitted after the last one count, so the next
  // turn's own effort becomes the top-level value and nothing before the summary carries a marker.
  const starts = new Map<string, { readonly turnId: string; readonly effort: string | null }>();
  const owned = new Map<string, string>();
  let fresh = 0;
  facts.forEach((fact, index) => {
    if (fact.type === 'history_replaced' || fact.type === 'session_rotated') fresh = index + 1;
  });
  for (const fact of facts.slice(fresh)) {
    if (fact.type !== 'turn_started' || !fact.requestConfiguration) continue;
    const configuration = fact.requestConfiguration;
    if (configuration.provider !== model.provider || configuration.model !== model.model) continue;
    for (const item of fact.input) owned.set(item.id, fact.turnId);
    starts.set(fact.turnId, { turnId: fact.turnId, effort: configuration.reasoningEffort });
  }
  const combined = [...history, ...newItems];
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

/** A turn's model history, new items and top-level effort, decorated where the model supports it. */
export function effortTimelineForTurn(
  facts: readonly Fact[],
  models: ModelRegistry,
  settings: { readonly model?: ModelRef; readonly reasoning?: ReasoningEffort },
  turn: { readonly modelHistory: readonly Item[]; readonly sentInput: readonly Item[] },
): {
  readonly modelHistory: readonly Item[];
  readonly sentInput: readonly Item[];
  readonly reasoning?: ReasoningEffort;
} {
  const { model, reasoning } = settings;
  // Markers are derived, never history: drop any that reached the log (an older compaction) before re-deriving.
  const raw = { modelHistory: withoutMarkers(turn.modelHistory), sentInput: withoutMarkers(turn.sentInput) };
  const unchanged = { ...raw, ...(reasoning !== undefined ? { reasoning } : {}) };
  if (!model || !reasoning) return unchanged;
  let levels: readonly ReasoningEffort[] | undefined;
  try {
    levels = effortUpdateLevels(models.resolve(model));
  } catch {
    return unchanged;
  }
  const plan = planEffortTimeline({
    facts,
    history: raw.modelHistory,
    newItems: raw.sentInput,
    model,
    reasoning,
    levels,
  });
  return plan ? { modelHistory: plan.history, sentInput: plan.newItems, reasoning: plan.reasoning } : unchanged;
}

const withoutMarkers = (items: readonly Item[]): readonly Item[] =>
  items.some(isEffortUpdateItem) ? items.filter((item) => !isEffortUpdateItem(item)) : items;

/** An endpoint refused a marker earlier in this session (model/provider.ts retried without it). */
function effortUpdatesRejected(facts: readonly Fact[]): boolean {
  return facts.some(
    (fact) => fact.type === 'model_response_completed' && fact.providerMetadata?.[EFFORT_UPDATES_REJECTED] === true,
  );
}

/**
 * Last line of defence for every request of a turn: the effort in effect must be the one the turn
 * was admitted at. A marker can be lost to an automatic compaction mid-turn, or be stale; then this
 * request goes out as today's, with no markers and the turn's effort top-level.
 */
export function alignTurnEffort(request: ModelRequest, facts: readonly Fact[], turnId: string): ModelRequest {
  const started = facts.find((fact) => fact.type === 'turn_started' && fact.turnId === turnId);
  const configured = started?.type === 'turn_started' ? started.requestConfiguration : undefined;
  if (!configured || configured.provider !== request.model.provider || configured.model !== request.model.model)
    return request;
  const selected = configured.reasoningEffort ?? undefined;
  if ((lastEffortUpdate(request.input) ?? request.reasoning) === selected) return request;
  const { reasoning: _stale, ...rest } = request;
  return {
    ...rest,
    input: withoutMarkers(request.input),
    ...(selected !== undefined ? { reasoning: selected as ReasoningEffort } : {}),
  };
}

/** One plain notice on the turn whose response first fell back. */
export function effortFallbackNotice(facts: readonly Fact[], turnId: string): string | undefined {
  const fallback = facts.find(
    (fact) => fact.type === 'model_response_completed' && fact.providerMetadata?.[EFFORT_UPDATES_REJECTED] === true,
  );
  return fallback?.type === 'model_response_completed' && fallback.turnId === turnId
    ? 'This endpoint does not support changing reasoning effort without losing the prompt cache, so that is turned off for this session; effort changes now apply the usual way.'
    : undefined;
}
