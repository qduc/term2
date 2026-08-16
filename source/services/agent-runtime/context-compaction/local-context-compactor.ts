import type { ContextSummaryMarker, ProviderInputItem } from '../../../contracts/provider-input.js';
import { isLocalContextSummary } from '../../../contracts/provider-input.js';
import type { ModelRequestCost } from '../../cost/model-cost.js';
import { buildContextCompactionInput, wrapContextSummary } from '../../../prompts/context-compaction.js';
import { projectConversationMessage } from '../../conversation/conversation-message-projection.js';
import {
  estimateContext,
  planLocalCompaction,
  rearmAtTokens,
  resolveCompactionThreshold,
  serializeColdPrefix,
  shouldDeferAutomaticCompaction,
  type ContextEstimate,
} from './index.js';

export interface SummaryGenerationResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  costRecords?: ModelRequestCost[];
}

export interface ContextSummaryGenerator {
  generate(input: {
    priorSummary: string | null;
    transcriptChunk: string;
    renderedInput: string;
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): Promise<SummaryGenerationResult>;
}

export class ContextCompactionHardFitError extends Error {
  readonly code = 'context_compaction_hard_fit' as const;
  readonly reason: 'single_turn_too_large' | 'result_still_too_large';

  constructor(reason: 'single_turn_too_large' | 'result_still_too_large') {
    super(
      reason === 'single_turn_too_large'
        ? 'The protected recent conversation is too large to fit the configured context window'
        : 'The compacted conversation is still too large to fit the configured context window',
    );
    this.name = 'ContextCompactionHardFitError';
    this.reason = reason;
  }
}

export type ContextSummaryCheckpoint = ProviderInputItem & { contextSummary: ContextSummaryMarker };

export type LocalCompactionOutcome =
  | { kind: 'not_needed'; estimate: ContextEstimate }
  | { kind: 'deferred'; reason: 'hysteresis' | 'per_run_cap'; estimate: ContextEstimate }
  | {
      kind: 'compacted';
      checkpoint: ContextSummaryCheckpoint;
      hotTail: ProviderInputItem[];
      estimate: ContextEstimate;
      rearmAtTokens: number;
      usage: { inputTokens: number; outputTokens: number };
      costRecords: ModelRequestCost[];
      /**
       * Provider-opaque items discarded with the cold turns they belonged to.
       * Reported so callers can log the loss; it is expected, not an error.
       */
      droppedOpaqueItems: number;
    }
  | {
      kind: 'blocked';
      reason:
        | 'single_turn_too_large'
        | 'result_still_too_large'
        | 'no_complete_cold_turn'
        | 'hot_tail_would_orphan_tool_result';
      estimate: ContextEstimate;
    };

export interface LocalCompactionInput {
  history: readonly ProviderInputItem[];
  instructions?: string;
  tools?: unknown;
  provider: string;
  model: string;
  sourceRevision: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  compactThreshold: number;
  compactThresholdTokens: number | null;
  manual: boolean;
  automaticCompactionsThisRun?: number;
  hasCompleteNewUserTurn?: boolean;
  checkpoint?: { rearmAtEstimatedTokens?: number };
  signal?: AbortSignal;
}

const addUsage = (
  total: { inputTokens: number; outputTokens: number },
  usage: SummaryGenerationResult['usage'],
): void => {
  total.inputTokens += usage?.inputTokens ?? 0;
  total.outputTokens += usage?.outputTokens ?? 0;
};

const checkpointSummaryText = (item: ProviderInputItem): string | null => {
  if (!isLocalContextSummary(item) || typeof item.content !== 'string') return null;
  const match = /<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(item.content);
  return match?.[1]?.trim() ?? item.content;
};

/**
 * Every provider-opaque item describes one *completed* assistant turn:
 * Responses reasoning and its paired call, a Chat Completions continuation
 * payload, or an earlier native compaction marker. None of them are meaningful
 * on their own, and none of them are readable — they are ciphertext or
 * provider-private signatures.
 *
 * Once the whole cold turn they belong to is replaced by a local checkpoint,
 * the correct treatment is to drop them, not to preserve or summarize them:
 *
 * - Preserving one would orphan it. Every provider that validates these items
 *   validates them *as a pair* with the call they precede — OpenAI rejects
 *   `'reasoning' … without its required following item` and the symmetric
 *   `'function_call' … without its required 'reasoning' item`; Gemini rejects
 *   a `functionCall` whose `thoughtSignature` is missing. Keeping the opaque
 *   half while the checkpoint swallows its turn is exactly the shape those
 *   errors describe.
 * - Summarizing one is impossible. The payload is encrypted or signed; feeding
 *   it to the summarizer spends tokens on noise and leaks provider-private
 *   state into a prompt.
 * - Dropping one is explicitly sanctioned. OpenAI's compaction guide says you
 *   may "drop items that came before the most recent compaction item", and
 *   reasoning items are documented as optional in multi-turn conversation once
 *   their turn is closed.
 *
 * Cutting a *whole* cold turn is therefore always safe; the invariant that
 * matters is the cut point, not the item type. `planLocalCompaction` cuts only
 * at a genuine user message, so no pair is ever split. See
 * `assertHotTailPairsIntact` for the enforcement of that invariant.
 */
const isProviderOpaqueItem = (item: ProviderInputItem): boolean => item.providerOpaque !== undefined;

const isToolCallItem = (item: ProviderInputItem): boolean => item.type === 'function_call' || item.type === 'tool_call';

const isToolResultItem = (item: ProviderInputItem): boolean =>
  item.type === 'function_call_result' || item.type === 'tool_result';

const callIdOf = (item: ProviderInputItem): string | undefined => {
  for (const key of ['callId', 'call_id', 'tool_call_id', 'toolCallId', 'id'] as const) {
    const value = (item as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
};

/**
 * The hot tail is replayed verbatim behind the checkpoint, so a tool result
 * whose call was summarized away is a provider 400 on every lane we support
 * ("No tool output found for function call" and its cousins). The cut is made
 * at a genuine user message, which structurally cannot separate a call from its
 * result — this asserts that structural claim rather than trusting it, because
 * the cost of being wrong is an unrecoverable conversation.
 */
const assertHotTailPairsIntact = (hotTail: readonly ProviderInputItem[]): boolean => {
  const calls = new Set<string>();
  for (const item of hotTail) {
    if (isToolCallItem(item)) {
      const id = callIdOf(item);
      if (id) calls.add(id);
      continue;
    }
    if (!isToolResultItem(item)) continue;
    const id = callIdOf(item);
    if (id && !calls.has(id)) return false;
  }
  return true;
};

const chunkColdPrefix = (items: readonly ProviderInputItem[], maxCharacters: number): string[] => {
  const turns: ProviderInputItem[][] = [];
  for (const item of items) {
    const message = projectConversationMessage(item);
    if (message?.role === 'user' && !message.isSynthetic) turns.push([]);
    (turns.at(-1) ?? (turns[0] = [])).push(item);
  }
  const chunks: string[] = [];
  let chunk: ProviderInputItem[] = [];
  for (const turn of turns) {
    const candidate = serializeColdPrefix([...chunk, ...turn]);
    if (chunk.length > 0 && candidate.length > maxCharacters) {
      chunks.push(serializeColdPrefix(chunk));
      chunk = [...turn];
    } else {
      chunk.push(...turn);
    }
  }
  if (chunk.length > 0) chunks.push(serializeColdPrefix(chunk));
  return chunks;
};

export class LocalContextCompactor {
  readonly #generator: ContextSummaryGenerator;

  constructor(generator: ContextSummaryGenerator) {
    this.#generator = generator;
  }

  async compactAtBoundary(input: LocalCompactionInput): Promise<LocalCompactionOutcome> {
    const threshold = resolveCompactionThreshold({
      contextWindow: input.contextWindow,
      compactThreshold: input.compactThreshold,
      compactThresholdTokens: input.compactThresholdTokens,
    });
    if (!threshold.available) {
      if (input.manual) throw new Error('Set agent.contextCompaction.compactThresholdTokens for an uncatalogued model');
      return { kind: 'not_needed', estimate: estimateContext(input) };
    }
    const estimate = estimateContext(input);
    if (!input.manual && estimate.renderedInputTokens < threshold.effectiveThreshold) {
      return { kind: 'not_needed', estimate };
    }
    if (!input.manual) {
      const deferred = shouldDeferAutomaticCompaction({
        automaticCompactionsThisRun: input.automaticCompactionsThisRun ?? 0,
        checkpoint: input.checkpoint,
        renderedInputTokens: estimate.renderedInputTokens,
        hasCompleteNewUserTurn: input.hasCompleteNewUserTurn ?? false,
      });
      if (deferred) return { kind: 'deferred', reason: deferred, estimate };
    }

    const usableWindow =
      input.contextWindow ?? Math.min(input.compactThresholdTokens ?? threshold.effectiveThreshold, 64_000);
    const usableInputTokens = Math.max(
      1_000,
      usableWindow - (input.maxOutputTokens ?? 0) - Math.ceil(usableWindow * 0.1),
    );
    const plan = planLocalCompaction({ history: input.history, usableInputTokens });
    if (plan.kind === 'blocked') return { kind: 'blocked', reason: plan.reason, estimate };

    if (!assertHotTailPairsIntact(plan.hotTail)) {
      return { kind: 'blocked', reason: 'hot_tail_would_orphan_tool_result', estimate };
    }

    // Leave the remaining 10% of the half-window budget for the bounded
    // running summary carried into every chunk after the first.
    const priorCheckpoint = plan.coldPrefix.find(isLocalContextSummary);
    const coldItems = plan.coldPrefix.filter((item) => !isLocalContextSummary(item) && !isProviderOpaqueItem(item));
    const droppedOpaqueItems = plan.coldPrefix.filter(isProviderOpaqueItem).length;
    const maxChunkCharacters = Math.max(4_000, Math.floor(usableInputTokens * 0.4 * 4));
    const chunks = chunkColdPrefix(coldItems, maxChunkCharacters);
    const summaryOutputCap = Math.max(
      256,
      Math.min(32_000, input.maxOutputTokens ?? 32_000, Math.floor(usableInputTokens * 0.1)),
    );
    let summary: string | null = priorCheckpoint ? checkpointSummaryText(priorCheckpoint) : null;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const costRecords: ModelRequestCost[] = [];
    for (const transcriptChunk of chunks) {
      const result = await this.#generator.generate({
        priorSummary: summary,
        transcriptChunk,
        renderedInput: buildContextCompactionInput(summary, transcriptChunk),
        maxOutputTokens: summaryOutputCap,
        signal: input.signal,
      });
      summary = result.text;
      addUsage(usage, result.usage);
      if (result.costRecords) costRecords.push(...result.costRecords);
    }

    const content = wrapContextSummary(summary ?? '');
    const postEstimate = estimateContext({
      ...input,
      history: [{ role: 'system', type: 'message', content }, ...plan.hotTail],
    });
    if (postEstimate.hardFitTokens > usableWindow) {
      return { kind: 'blocked', reason: 'result_still_too_large', estimate: postEstimate };
    }
    const rearmAt = rearmAtTokens(postEstimate.renderedInputTokens, threshold.effectiveThreshold);
    const checkpoint: ContextSummaryCheckpoint = {
      role: 'system',
      type: 'message',
      content,
      contextSummary: {
        version: 1,
        strategy: 'local',
        replacesThroughRevision: input.sourceRevision,
        sourceProvider: input.provider,
        sourceModel: input.model,
        estimatedTokensBefore: estimate.renderedInputTokens,
        estimatedTokensAfter: postEstimate.renderedInputTokens,
        rearmAtEstimatedTokens: rearmAt,
      },
    };
    return {
      kind: 'compacted',
      checkpoint,
      hotTail: plan.hotTail,
      estimate: postEstimate,
      rearmAtTokens: rearmAt,
      usage,
      costRecords,
      droppedOpaqueItems,
    };
  }
}
