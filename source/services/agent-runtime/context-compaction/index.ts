import { projectConversationMessage } from '../../conversation/conversation-message-projection.js';
import { projectModelRequestHistory } from '../../conversation/conversation-state-projector.js';
import type { ProviderInputItem } from '../../../contracts/provider-input.js';

export type CompactionThresholdSource = 'ratio' | 'tokens' | 'both';

export type ResolvedCompactionThreshold =
  | {
      available: true;
      ratioThreshold?: number;
      tokenThreshold?: number;
      effectiveThreshold: number;
      thresholdSource: CompactionThresholdSource;
    }
  | { available: false; reason: 'uncatalogued_without_token_threshold' };

export function resolveCompactionThreshold(input: {
  contextWindow?: number;
  compactThreshold: number;
  compactThresholdTokens: number | null;
}): ResolvedCompactionThreshold {
  const { compactThreshold, compactThresholdTokens } = input;
  if (!Number.isFinite(compactThreshold) || compactThreshold < 0 || compactThreshold > 1) {
    throw new RangeError('compactThreshold must be a finite ratio between 0 and 1');
  }
  if (
    compactThresholdTokens !== null &&
    (!Number.isFinite(compactThresholdTokens) ||
      !Number.isInteger(compactThresholdTokens) ||
      compactThresholdTokens < 1_000)
  ) {
    throw new RangeError('compactThresholdTokens must be null or an integer of at least 1000');
  }

  const ratioThreshold =
    input.contextWindow === undefined ? undefined : Math.max(1_000, Math.round(input.contextWindow * compactThreshold));
  if (ratioThreshold === undefined && compactThresholdTokens === null) {
    return { available: false, reason: 'uncatalogued_without_token_threshold' };
  }
  if (ratioThreshold === undefined) {
    return {
      available: true,
      tokenThreshold: compactThresholdTokens!,
      effectiveThreshold: compactThresholdTokens!,
      thresholdSource: 'tokens',
    };
  }
  if (compactThresholdTokens === null) {
    return { available: true, ratioThreshold, effectiveThreshold: ratioThreshold, thresholdSource: 'ratio' };
  }
  const thresholdSource =
    ratioThreshold === compactThresholdTokens ? 'both' : ratioThreshold < compactThresholdTokens ? 'ratio' : 'tokens';
  return {
    available: true,
    ratioThreshold,
    tokenThreshold: compactThresholdTokens,
    effectiveThreshold: Math.min(ratioThreshold, compactThresholdTokens),
    thresholdSource,
  };
}

export interface ContextEstimate {
  renderedInputTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  hardFitTokens: number;
}

const serializedBytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Buffer.byteLength(String(value));
  }
};

export function estimateContext(input: {
  history: readonly ProviderInputItem[];
  instructions?: unknown;
  tools?: unknown;
  contextWindow?: number;
  maxOutputTokens?: number;
}): ContextEstimate {
  const renderedBytes = serializedBytes({
    instructions: input.instructions ?? '',
    tools: input.tools ?? [],
    history: projectModelRequestHistory(input.history),
  });
  const renderedInputTokens = Math.ceil(renderedBytes / 4);
  const outputReserveTokens = Math.max(0, Math.ceil(input.maxOutputTokens ?? 0));
  const safetyReserveTokens = Math.ceil((input.contextWindow ?? 0) * 0.1);
  return {
    renderedInputTokens,
    outputReserveTokens,
    safetyReserveTokens,
    hardFitTokens: renderedInputTokens + outputReserveTokens + safetyReserveTokens,
  };
}

type TurnRange = { start: number; end: number };

const genuineUserTurnStarts = (history: readonly ProviderInputItem[]): number[] => {
  const starts: number[] = [];
  history.forEach((item, index) => {
    const message = projectConversationMessage(item);
    if (message?.role === 'user' && !message.isSynthetic) starts.push(index);
  });
  return starts;
};

const turnRanges = (history: readonly ProviderInputItem[]): TurnRange[] => {
  const starts = genuineUserTurnStarts(history);
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? history.length }));
};

export type LocalCompactionPlan =
  | { kind: 'planned'; coldPrefix: ProviderInputItem[]; hotTail: ProviderInputItem[]; hotTailBudgetTokens: number }
  | { kind: 'blocked'; reason: 'no_complete_cold_turn' | 'single_turn_too_large' };

export function planLocalCompaction(input: {
  history: readonly ProviderInputItem[];
  usableInputTokens: number;
}): LocalCompactionPlan {
  const history = projectModelRequestHistory(input.history);
  const turns = turnRanges(history);
  if (turns.length < 3) return { kind: 'blocked', reason: 'no_complete_cold_turn' };

  const hotTailBudgetTokens = Math.min(32_000, Math.max(8_000, Math.floor(input.usableInputTokens * 0.25)));
  const hotStartTurn = turns.length - 2;
  const hotTokens = Math.ceil(serializedBytes(history.slice(turns[hotStartTurn]!.start)) / 4);
  if (hotTokens > input.usableInputTokens) return { kind: 'blocked', reason: 'single_turn_too_large' };
  const cut = turns[hotStartTurn]!.start;
  if (cut <= 0) return { kind: 'blocked', reason: 'no_complete_cold_turn' };
  return {
    kind: 'planned',
    coldPrefix: structuredClone(history.slice(0, cut)),
    hotTail: structuredClone(history.slice(cut)),
    hotTailBudgetTokens,
  };
}

const stableValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export function serializeColdPrefix(
  history: readonly ProviderInputItem[],
  options: { maxToolResultCharacters?: number } = {},
): string {
  const limit = options.maxToolResultCharacters ?? 12_000;
  const modeled = history.map((item) => {
    const type = item.type;
    if (type !== 'function_call_result' && type !== 'tool_result') return structuredClone(item);
    const output = stableValue(item.output);
    if (output.length <= limit) return structuredClone(item);
    const excerpt = Math.max(1, Math.floor(limit / 2));
    return {
      ...structuredClone(item),
      output: `[truncated tool result: name=${String(item.name ?? 'unknown')} callId=${String(
        item.callId ?? item.call_id ?? 'unknown',
      )} status=completed bytes=${Buffer.byteLength(output)}]\n${output.slice(0, excerpt)}\n…\n${output.slice(
        -excerpt,
      )}`,
    };
  });
  return JSON.stringify(modeled, null, 2);
}

export const rearmAtTokens = (postCompactionEstimatedTokens: number, effectiveThreshold: number): number =>
  postCompactionEstimatedTokens + Math.max(8_000, Math.ceil(effectiveThreshold * 0.1));

export function shouldDeferAutomaticCompaction(input: {
  automaticCompactionsThisRun: number;
  checkpoint?: { rearmAtEstimatedTokens?: number };
  renderedInputTokens: number;
  hasCompleteNewUserTurn: boolean;
}): 'per_run_cap' | 'hysteresis' | null {
  if (input.automaticCompactionsThisRun >= 1) return 'per_run_cap';
  const rearmAt = input.checkpoint?.rearmAtEstimatedTokens;
  if (rearmAt !== undefined && (!input.hasCompleteNewUserTurn || input.renderedInputTokens < rearmAt))
    return 'hysteresis';
  return null;
}
