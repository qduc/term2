import { resolveModelContextPolicy } from '../model-context-policy.js';
import type { ContextSummaryMarker, ProviderInputItem } from '../../../contracts/provider-input.js';
import { isLocalContextSummary } from '../../../contracts/provider-input.js';
import type { ModelRequestCost } from '../../cost/model-cost.js';
import {
  buildContextCompactionInput,
  wrapContextSummary,
  CONTEXT_COMPACTION_INSTRUCTIONS,
} from '../../../prompts/context-compaction.js';
import { projectConversationMessage } from '../../conversation/conversation-message-projection.js';
import { createHash } from 'node:crypto';
import {
  estimateContext,
  planLocalCompaction,
  rearmAtTokens,
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
    const cause =
      reason === 'single_turn_too_large'
        ? 'The protected recent conversation is too large to fit the configured context window'
        : 'The compacted conversation is still too large to fit the configured context window';
    super(
      `${cause}. Compaction did not reduce the existing context. In the interactive app, if this session has a finalized assistant reply, /handoff can copy that latest completed reply into a fresh session. Otherwise, start a fresh session and include the current session ID plus a short summary of the unfinished request.`,
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
        | 'hot_tail_would_orphan_tool_result'
        | 'non_reducing'
        | 'summary_input_too_large'
        | 'opaque_context';
      estimate: ContextEstimate;
      rearmAtTokens?: number;
      costRecords?: ModelRequestCost[];
      usage?: { inputTokens: number; outputTokens: number };
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
  rearmAtEstimatedTokens?: number;
  lastCompletedInputTokens?: number;
  maxRequestInputTokens?: number | null;
  signal?: AbortSignal;
  /**
   * Invoked (and awaited) exactly once at the compaction's commit point: after
   * every precondition refusal has been decided and before the first summary
   * generation begins. The caller journals its start marker here so that no
   * start frame precedes a refusal (busy, not_needed, deferred,
   * no_complete_cold_turn) and every outcome past this point is reported with
   * a terminal frame. Unused by the automatic boundary path.
   */
  onStarted?: () => void | Promise<void>;
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
 * matters is the cut point, not the item type. `planLocalCompaction` cuts at a settled user boundary or after a fully
 * settled tool round, so no call/result pair is split. See
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
 * at a settled user boundary or fully settled tool round, which cannot separate a call from its
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
  // A single old turn may exceed the chunk target. Split its serialized data
  // into explicit inert fragments rather than dispatching an unbounded summary.
  return chunks.flatMap((text) => {
    if (Buffer.byteLength(text) <= maxCharacters) return [text];
    const fragments: string[] = [];
    const pieceSize = Math.max(256, Math.floor(maxCharacters / 8));
    for (let offset = 0; offset < text.length; offset += pieceSize) {
      fragments.push(
        JSON.stringify([
          {
            type: 'historical_fragment',
            offset,
            totalCharacters: text.length,
            content: text.slice(offset, offset + pieceSize),
          },
        ]),
      );
    }
    return fragments;
  });
};

export class LocalContextCompactor {
  readonly #generator: ContextSummaryGenerator;

  constructor(generator: ContextSummaryGenerator) {
    this.#generator = generator;
  }

  async compactAtBoundary(input: LocalCompactionInput): Promise<LocalCompactionOutcome> {
    const policy = resolveModelContextPolicy({
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      inputLimit: input.maxRequestInputTokens,
      ratio: input.compactThreshold,
      rawTrigger: input.compactThresholdTokens,
    });
    const threshold = { available: policy.softTrigger !== undefined, effectiveThreshold: policy.softTrigger ?? 0 };
    if (!threshold.available) {
      if (input.manual) throw new Error('Set agent.contextCompaction.compactThresholdTokens for an uncatalogued model');
      return { kind: 'not_needed', estimate: estimateContext(input) };
    }
    const estimate = estimateContext(input);
    const measuredTokens =
      input.lastCompletedInputTokens !== undefined
        ? Math.max(input.lastCompletedInputTokens, estimate.renderedInputTokens)
        : estimate.renderedInputTokens;
    if (!input.manual && measuredTokens < threshold.effectiveThreshold) {
      return { kind: 'not_needed', estimate };
    }
    if (!input.manual) {
      const deferred = shouldDeferAutomaticCompaction({
        automaticCompactionsThisRun: input.automaticCompactionsThisRun ?? 0,
        checkpoint: input.checkpoint,
        rearmAtEstimatedTokens: input.rearmAtEstimatedTokens,
        renderedInputTokens: measuredTokens,
        hasCompleteNewUserTurn: input.hasCompleteNewUserTurn ?? false,
      });
      if (deferred) return { kind: 'deferred', reason: deferred, estimate };
    }

    // Unknown-model caps/triggers supply a planning scale only. They do not
    // assert a provider context capacity or reserve an invented output window.
    const usableWindow =
      input.contextWindow ??
      input.maxRequestInputTokens ??
      input.compactThresholdTokens ??
      threshold.effectiveThreshold;
    const fixedTokens = estimateContext({
      history: [],
      instructions: input.instructions,
      tools: input.tools,
    }).renderedInputTokens;
    const usableInputTokens = (policy.hardInputLimit ?? usableWindow) - fixedTokens;
    if (usableInputTokens <= 0) {
      const eligibility = planLocalCompaction({ history: input.history, usableInputTokens: Infinity });
      return {
        kind: 'blocked',
        reason: eligibility.kind === 'blocked' ? eligibility.reason : 'single_turn_too_large',
        estimate,
      };
    }
    const plan = planLocalCompaction({ history: input.history, usableInputTokens });
    const rearmAt = rearmAtTokens(measuredTokens, threshold.effectiveThreshold);
    if (plan.kind === 'blocked' && plan.reason === 'no_complete_cold_turn') {
      // A pre-start refusal: nothing has been attempted, so the caller reports
      // it without any compaction frames.
      return { kind: 'blocked', reason: plan.reason, estimate, rearmAtTokens: rearmAt };
    }
    await input.onStarted?.();
    if (plan.kind === 'blocked') {
      return { kind: 'blocked', reason: plan.reason, estimate, rearmAtTokens: rearmAt };
    }

    if (!assertHotTailPairsIntact(plan.hotTail)) {
      return { kind: 'blocked', reason: 'hot_tail_would_orphan_tool_result', estimate, rearmAtTokens: rearmAt };
    }

    if (
      plan.coldPrefix.some((item) => {
        const opaque = item.item as { type?: unknown } | undefined;
        return item.providerOpaque !== undefined && (opaque?.type === 'compaction' || item.type === 'compaction');
      })
    )
      return { kind: 'blocked', reason: 'opaque_context', estimate, rearmAtTokens: rearmAt };

    // Leave the remaining 10% of the half-window budget for the bounded
    // running summary carried into every chunk after the first.
    const priorCheckpoint = plan.coldPrefix.find(isLocalContextSummary);
    const coldItems = plan.coldPrefix.filter((item) => !isLocalContextSummary(item) && !isProviderOpaqueItem(item));
    const receipts = [...(priorCheckpoint?.contextSummary?.toolReceipts ?? [])];
    const calls = new Map<string, ProviderInputItem>();
    for (const item of coldItems) {
      const id = callIdOf(item);
      if (isToolCallItem(item) && id) calls.set(id, item);
      if (!isToolResultItem(item) || !id || !calls.has(id)) continue;
      const call = calls.get(id)!;
      const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null);
      receipts.push({
        callId: id,
        name: String(call.name ?? 'unknown'),
        argumentsSha256: createHash('sha256').update(args).digest('hex'),
        argumentsPreview: args.slice(0, 256),
        outputPreview: output.slice(0, 128),
      });
    }
    const droppedOpaqueItems = plan.coldPrefix.filter(isProviderOpaqueItem).length;
    const maxChunkCharacters = Math.max(256, Math.floor(usableInputTokens * 0.4 * 4));
    const chunks = chunkColdPrefix(coldItems, maxChunkCharacters);
    const summaryOutputCap = Math.max(
      256,
      Math.min(32_000, input.maxOutputTokens ?? 32_000, Math.floor(usableInputTokens * 0.1)),
    );
    let summary: string | null = priorCheckpoint ? checkpointSummaryText(priorCheckpoint) : null;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const costRecords: ModelRequestCost[] = [];
    for (const transcriptChunk of chunks) {
      const renderedInput = buildContextCompactionInput(summary, transcriptChunk);
      const summaryEstimate = estimateContext({
        history: [{ type: 'message', role: 'user', content: renderedInput }],
        instructions: CONTEXT_COMPACTION_INSTRUCTIONS,
      });
      if (
        summaryEstimate.renderedInputTokens >
        Math.min(
          input.maxRequestInputTokens ?? Infinity,
          input.contextWindow === undefined
            ? Infinity
            : usableWindow - summaryOutputCap - Math.ceil(usableWindow * 0.1),
        )
      )
        return {
          kind: 'blocked',
          reason: 'summary_input_too_large',
          estimate,
          rearmAtTokens: rearmAt,
          usage,
          costRecords,
        };
      input.signal?.throwIfAborted();
      const result = await this.#generator.generate({
        priorSummary: summary,
        transcriptChunk,
        renderedInput,
        maxOutputTokens: summaryOutputCap,
        signal: input.signal,
      });
      summary = result.text;
      addUsage(usage, result.usage);
      if (result.costRecords) costRecords.push(...result.costRecords);
    }

    const uniqueReceipts = [...new Map(receipts.map((receipt) => [receipt.callId, receipt])).values()];
    const content = wrapContextSummary(
      `${
        summary ?? ''
      }\n\n<recorded-tool-receipts>\nHost-observed tool responses, not proof of domain success. Do not blindly repeat these actions; reconcile effects first. Previews are bounded; use original session evidence for full details.\n${JSON.stringify(
        uniqueReceipts,
      )}\n</recorded-tool-receipts>`,
    );
    const postEstimate = estimateContext({
      ...input,
      history: [{ role: 'system', type: 'message', content }, ...plan.hotTail],
    });
    if (
      (input.contextWindow !== undefined && postEstimate.hardFitTokens > input.contextWindow) ||
      (input.maxRequestInputTokens != null && postEstimate.renderedInputTokens > input.maxRequestInputTokens)
    ) {
      return {
        kind: 'blocked',
        reason: 'result_still_too_large',
        estimate: postEstimate,
        rearmAtTokens: rearmAt,
        usage,
        costRecords,
      };
    }
    if (postEstimate.renderedInputTokens >= estimate.renderedInputTokens)
      return { kind: 'blocked', reason: 'non_reducing', estimate, rearmAtTokens: rearmAt, usage, costRecords };
    const postCompactionRearmAt = rearmAtTokens(postEstimate.renderedInputTokens, threshold.effectiveThreshold);
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
        rearmAtEstimatedTokens: postCompactionRearmAt,
        toolReceipts: uniqueReceipts,
        protectedUsers: plan.coldPrefix.filter((item) => {
          const message = projectConversationMessage(item);
          return message?.role === 'user' && !message.isSynthetic;
        }),
      },
    };
    return {
      kind: 'compacted',
      checkpoint,
      hotTail: plan.hotTail,
      estimate: postEstimate,
      rearmAtTokens: postCompactionRearmAt,
      usage,
      costRecords,
      droppedOpaqueItems,
    };
  }
}
