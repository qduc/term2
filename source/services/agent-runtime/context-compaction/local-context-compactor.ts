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
    }
  | {
      kind: 'blocked';
      reason: 'single_turn_too_large' | 'result_still_too_large' | 'no_complete_cold_turn';
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
    if (input.history.some((item) => item.providerOpaque !== undefined)) {
      throw new Error('Local compaction cannot summarize indispensable provider-opaque history');
    }
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

    // Leave the remaining 10% of the half-window budget for the bounded
    // running summary carried into every chunk after the first.
    const priorCheckpoint = plan.coldPrefix.find(isLocalContextSummary);
    const coldItems = plan.coldPrefix.filter((item) => !isLocalContextSummary(item));
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
    };
  }
}
