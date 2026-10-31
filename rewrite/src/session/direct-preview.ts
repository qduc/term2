/** Pure native preview values and accepted occurrence/lifecycle provenance. */
import type { ContentPart, Item } from '../model/index.js';
import type { Fact, FactLine } from './facts.js';
import type { TurnRequest } from './direct-types.js';

export type DirectPreviewRequest = { readonly text: string; readonly attachments?: readonly ContentPart[] };
export type DirectPreviewConfiguration = {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly mode: string;
};
export type DirectToolOccurrence = { readonly turnId: string; readonly occurrence: number };
export type DirectPlannedInput = {
  readonly input: readonly Item[];
  readonly kind: 'full_history' | 'delta';
  readonly configuration: DirectPreviewConfiguration;
  readonly queueActive: boolean;
  readonly toolOccurrences: readonly (DirectToolOccurrence | null)[];
};
export type DirectPreviewSnapshot = DirectPlannedInput & {
  readonly lastSuccessful: (DirectPreviewConfiguration & { readonly completedAt: number }) | null;
  readonly resumed: { readonly updatedAtMs: number | null } | null;
  readonly rewoundSinceSuccess: boolean;
};

/** Do not guess a profile label from model/display names or convert unknown config into a baseline. */
export function directPreviewConfiguration(
  request: Pick<TurnRequest, 'model' | 'reasoning' | 'previewMode'>,
): DirectPreviewConfiguration | undefined {
  return request.previewMode
    ? {
        provider: request.model.provider,
        model: request.model.model,
        reasoningEffort: request.reasoning ?? null,
        mode: request.previewMode,
      }
    : undefined;
}

/** References, not Item/provider IDs, bind accepted representations to a known physical admission. */
export function directPreviewOccurrences(
  facts: readonly Fact[],
  input: readonly Item[],
): readonly (DirectToolOccurrence | null)[] {
  const known = new WeakMap<Item, DirectToolOccurrence>();
  const executions = new Map<string, DirectToolOccurrence>();
  const counters = new Map<string, number>();
  for (const fact of facts) {
    if (fact.type !== 'item' || !fact.executionId) continue;
    if (fact.item.type === 'tool_call') {
      const occurrence = (counters.get(fact.turnId) ?? 0) + 1;
      counters.set(fact.turnId, occurrence);
      const evidence = { turnId: fact.turnId, occurrence };
      executions.set(fact.executionId, evidence);
      known.set(fact.item, evidence);
    } else if (fact.item.type === 'tool_result') {
      const evidence = executions.get(fact.executionId);
      if (evidence) known.set(fact.item, evidence);
    }
  }
  // A history replacement may not preserve object/admission evidence. Null is
  // truthful; never reconstruct it from repeated provider IDs or argument hashes.
  return input.map((item) => known.get(item) ?? null);
}

/** Actual accepted root response checkpoints establish success; branch/usage/UI records do not. */
export function directPreviewLifecycle(
  lines: readonly Pick<FactLine, 'seq' | 'at' | 'fact'>[],
  resumedAtSeq: number,
): Pick<DirectPreviewSnapshot, 'lastSuccessful' | 'resumed' | 'rewoundSinceSuccess'> {
  const configs = new Map<string, DirectPreviewConfiguration>();
  let lastSuccessful: DirectPreviewSnapshot['lastSuccessful'] = null;
  let rewoundSinceSuccess = false;
  const initial = lines.filter((line) => line.seq <= resumedAtSeq).at(-1);
  let resumed: DirectPreviewSnapshot['resumed'] = resumedAtSeq > 0 ? { updatedAtMs: timestamp(initial?.at) } : null;
  for (const line of lines) {
    const fact = line.fact;
    if (fact.type === 'turn_started' && fact.requestConfiguration) configs.set(fact.turnId, fact.requestConfiguration);
    if (line.seq <= resumedAtSeq) continue;
    if (fact.type === 'history_replaced' && fact.reason === 'rewind') rewoundSinceSuccess = true;
    if (fact.type !== 'model_response_completed') continue;
    const configuration = configs.get(fact.turnId);
    const completedAt = timestamp(line.at);
    if (!configuration || completedAt === null) continue;
    lastSuccessful = { ...configuration, completedAt };
    resumed = null;
    rewoundSinceSuccess = false;
  }
  return { lastSuccessful, resumed, rewoundSinceSuccess };
}

function timestamp(at: string | undefined): number | null {
  const value = at === undefined ? NaN : Date.parse(at);
  return Number.isFinite(value) ? value : null;
}
