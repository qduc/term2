/** Real compaction operations, returning proposals for Session's sole writer. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Item, ItemId, Model, ModelRef, ModelRequest, Usage } from '../model/index.js';
import { ModelFailure } from '../model/failure.js';
import { resolveModelContextPolicy } from '../../../source/services/agent-runtime/model-context-policy.js';
import { DEFAULT_ASSUMED_CONTEXT_WINDOW } from '../model/index.js';
import {
  CONTEXT_COMPACTION_INSTRUCTIONS,
  CONTEXT_COMPACTION_REQUEST,
  buildContextCompactionInput,
  wrapContextSummary,
} from '../../../source/prompts/context-compaction.js';
import { hasCompleteDirectToolPairs } from './direct-recovery-history.js';
import { selfContained } from './direct-recovery-continuity.js';

export type DirectCompactionSettings = {
  readonly enabled: boolean;
  readonly mode: 'native' | 'auto' | 'local';
  readonly compactThreshold: number;
  readonly compactThresholdTokens: number | null;
};
export type DirectContextEstimate = {
  readonly renderedInputTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly hardFitTokens: number;
};
/** A real compaction attempt, not a physical-dispatch or history-acceptance claim.
 * Estimates describe the frozen compaction input, not measured provider usage. */
export type DirectCompactionStart = {
  readonly trigger: 'manual' | 'automatic';
  readonly model: ModelRef;
  readonly strategy?: 'native' | 'local';
  readonly before: DirectContextEstimate;
  readonly contextWindow?: number;
  readonly maxRequestInputTokens?: number | null;
  readonly lastCompletedInputTokens?: number;
};
/** Observed auxiliary request evidence; unavailable usage/cost stays absent. */
export type DirectCompactionRequest = {
  readonly requestId: string;
  readonly modelStep: number;
  readonly model: ModelRef;
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  readonly usage?: Usage;
  readonly costUsd?: number | string;
};
export type DirectCompactionInput = {
  readonly request: ModelRequest;
  readonly model: Model;
  readonly settings: DirectCompactionSettings;
  readonly signal: AbortSignal;
  /** Use catalog capacity, not Model.contextWindow's synthetic fallback. */
  readonly contextWindow?: number;
  readonly maxRequestInputTokens?: number | null;
  readonly lastCompletedInputTokens?: number;
  readonly rearmAtEstimatedTokens?: number;
  /** Host-recorded receipt previews from the last accepted local checkpoint. */
  readonly checkpointReceipts?: readonly string[];
  readonly manual?: boolean;
  /** Await acceptance before attempting compaction. Automatic no-op scheduling
   * emits nothing; manual evaluation starts even if its plan is then blocked. */
  readonly onStarted?: (evidence: DirectCompactionStart) => Promise<void>;
  /** Request-local accounting, including usage observed before a failed summary. */
  readonly onSummaryUsage?: (usage: Usage, requestOrdinal: number) => void;
};
export type DirectCompactionResult =
  | { readonly kind: 'not_needed'; readonly estimate: DirectContextEstimate }
  | { readonly kind: 'deferred'; readonly reason: 'hysteresis'; readonly estimate: DirectContextEstimate }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'disabled'
        | 'unknown_threshold'
        | 'native_unavailable'
        | 'unsettled_tools'
        | 'no_complete_cold_turn'
        | 'single_turn_too_large'
        | 'opaque_context'
        | 'summary_input_too_large'
        | 'non_reducing'
        | 'result_still_too_large';
      readonly estimate: DirectContextEstimate;
      readonly usage?: readonly Usage[];
    }
  | {
      readonly kind: 'compacted';
      readonly strategy: 'native' | 'local';
      readonly history: readonly Item[];
      readonly replaces: readonly ItemId[];
      readonly before: DirectContextEstimate;
      readonly estimate: DirectContextEstimate;
      readonly rearmAtEstimatedTokens?: number;
      readonly usage: readonly Usage[];
      readonly checkpointReceipts: readonly string[];
      readonly disableChaining: true;
    };

/**
 * At a settled request boundary, compact via the actual injected model. No
 * synthetic success, automatic retry, persistence or tool execution. Exceptions
 * (including cancellation) propagate for the engine to report truthfully.
 * Session must commit a successful replacement before advancing, clear provider
 * continuity, and carry its rearm threshold forward only after that commit.
 */
export async function compactDirectHistory(input: DirectCompactionInput): Promise<DirectCompactionResult> {
  input.signal.throwIfAborted();
  validateSettings(input);
  const estimate = estimateDirectContext(input.request, input.contextWindow);
  // Selection is source-backed capability/configuration, not proof of dispatch.
  // Explicit native unavailability has no selected available strategy.
  const strategy =
    input.settings.mode === 'native' && !input.model.compact
      ? undefined
      : input.settings.mode !== 'local' && input.model.compact
      ? 'native'
      : 'local';
  const start = (): Promise<void> =>
    input.onStarted?.({
      trigger: input.manual ? 'manual' : 'automatic',
      model: input.request.model,
      ...(strategy !== undefined ? { strategy } : {}),
      before: estimate,
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      ...(input.maxRequestInputTokens !== undefined ? { maxRequestInputTokens: input.maxRequestInputTokens } : {}),
      ...(input.lastCompletedInputTokens !== undefined
        ? { lastCompletedInputTokens: input.lastCompletedInputTokens }
        : {}),
    }) ?? Promise.resolve();
  if (input.manual) {
    await start();
    input.signal.throwIfAborted();
  }
  // The setting schedules automatic maintenance; an explicit compact command
  // is independent, as in the source Session's compactContext manual path.
  if (!input.manual && !input.settings.enabled) return { kind: 'blocked', reason: 'disabled', estimate };
  if (!hasCompleteDirectToolPairs(input.request.input)) return { kind: 'blocked', reason: 'unsettled_tools', estimate };
  const policy = resolveModelContextPolicy({
    contextWindow: input.contextWindow,
    maxOutputTokens: input.request.maxOutputTokens,
    inputLimit: input.maxRequestInputTokens,
    ratio: input.settings.compactThreshold,
    rawTrigger: input.settings.compactThresholdTokens,
  });
  // The assumption schedules maintenance only; it must never become a hard admission limit.
  const softTrigger =
    input.manual || input.contextWindow !== undefined
      ? policy.softTrigger
      : Math.min(
          policy.softTrigger ?? Infinity,
          Math.floor(DEFAULT_ASSUMED_CONTEXT_WINDOW * input.settings.compactThreshold),
        );
  const measured = Math.max(estimate.renderedInputTokens, input.lastCompletedInputTokens ?? 0);
  if (!input.manual && softTrigger !== undefined && measured < softTrigger) return { kind: 'not_needed', estimate };
  if (!input.manual && input.rearmAtEstimatedTokens !== undefined && measured < input.rearmAtEstimatedTokens) {
    return { kind: 'deferred', reason: 'hysteresis', estimate };
  }
  if (!input.manual) await start();
  input.signal.throwIfAborted();
  // An explicit native choice never silently substitutes local summarization.
  if (input.settings.mode === 'native' && !input.model.compact)
    return { kind: 'blocked', reason: 'native_unavailable', estimate };
  const useNative = input.settings.mode !== 'local' && !!input.model.compact;
  const operation = useNative
    ? {
        history: await input.model.compact!(selfContained(input.request), input.signal),
        usage: [] as Usage[],
        checkpointReceipts: input.checkpointReceipts ?? [],
      }
    : await compactLocally(input, policy.hardInputLimit ?? softTrigger ?? Infinity, estimate);
  input.signal.throwIfAborted();
  if ('kind' in operation) return operation;
  const after = estimateDirectContext({ ...input.request, input: operation.history }, input.contextWindow);
  if (
    !operation.history.length ||
    isDeepStrictEqual(operation.history, input.request.input) ||
    after.renderedInputTokens >= estimate.renderedInputTokens
  ) {
    return { kind: 'blocked', reason: 'non_reducing', estimate, usage: operation.usage };
  }
  if (!hasCompleteDirectToolPairs(operation.history))
    throw new Error('Compaction returned orphaned tool calls/results');
  if (policy.hardInputLimit !== undefined && after.renderedInputTokens > policy.hardInputLimit) {
    return { kind: 'blocked', reason: 'result_still_too_large', estimate, usage: operation.usage };
  }
  const retained = new Set(operation.history.map((item) => item.id));
  return {
    kind: 'compacted',
    strategy: useNative ? 'native' : 'local',
    history: operation.history,
    replaces: input.request.input.filter((item) => !retained.has(item.id)).map((item) => item.id),
    before: estimate,
    estimate: after,
    ...(softTrigger === undefined
      ? {}
      : { rearmAtEstimatedTokens: after.renderedInputTokens + Math.max(1_000, Math.ceil(softTrigger * 0.1)) }),
    usage: operation.usage,
    checkpointReceipts: operation.checkpointReceipts,
    disableChaining: true,
  };
}

/** Conservative bytes/4 estimate with the existing 10% capacity reserve. Never changes history. */
export function estimateDirectContext(request: ModelRequest, contextWindow?: number): DirectContextEstimate {
  const renderedInputTokens = Math.ceil(
    bytes({ instructions: request.instructions, tools: request.tools, history: request.input }) / 4,
  );
  const outputReserveTokens = Math.max(0, Math.ceil(request.maxOutputTokens ?? 0));
  const safetyReserveTokens = Math.ceil((contextWindow ?? 0) * 0.1);
  return {
    renderedInputTokens,
    outputReserveTokens,
    safetyReserveTokens,
    hardFitTokens: renderedInputTokens + outputReserveTokens + safetyReserveTokens,
  };
}

/** Hard admission is independent of automatic compaction being enabled or eligible.
 * Call with the full prepared envelope, before continuity slices it to a delta. */
export function enforceDirectInputLimit(
  request: ModelRequest,
  input: { readonly maxRequestInputTokens?: number | null; readonly contextWindow?: number },
): void {
  const policy = resolveModelContextPolicy({
    contextWindow: input.contextWindow,
    maxOutputTokens: request.maxOutputTokens,
    inputLimit: input.maxRequestInputTokens,
  });
  if (policy.hardInputLimit === undefined) return;
  const estimated = estimateDirectContext(request, input.contextWindow).renderedInputTokens;
  if (estimated <= policy.hardInputLimit) return;
  throw new ModelFailure({
    kind: 'context_overflow',
    retryable: false,
    message:
      `request_input_limit: Request input exceeds ${
        policy.limitSource === 'model_capacity' ? 'known model capacity' : 'configured input ceiling'
      } ` +
      `(${estimated} > ${policy.hardInputLimit} tokens). Work is retained. Compact, choose a larger model, ` +
      'or explicitly raise agent.maxRequestInputTokens before resuming.',
  });
}

type LocalOperation =
  | { history: readonly Item[]; usage: readonly Usage[]; checkpointReceipts: readonly string[] }
  | Extract<DirectCompactionResult, { kind: 'blocked' }>;

async function compactLocally(
  input: DirectCompactionInput,
  usable: number,
  estimate: DirectContextEstimate,
): Promise<LocalOperation> {
  const plan = planTail(input.request.input, usable);
  if (typeof plan === 'string') return { kind: 'blocked', reason: plan, estimate };
  if (plan.cold.some((item) => item.type === 'provider_opaque' && item.item.type === 'compaction')) {
    return { kind: 'blocked', reason: 'opaque_context', estimate };
  }
  const summaryOutputCap = Math.max(
    256,
    Math.min(32_000, input.request.maxOutputTokens ?? 32_000, Math.floor(usable * 0.1)),
  );
  const liveRequest = selfContained({
    ...input.request,
    input: [...input.request.input, summaryMessage(CONTEXT_COMPACTION_REQUEST)],
    maxOutputTokens: summaryOutputCap,
  });
  const summaryInputLimit = Math.min(
    input.maxRequestInputTokens ?? Infinity,
    input.contextWindow === undefined
      ? Infinity
      : input.contextWindow - summaryOutputCap - Math.ceil(input.contextWindow * 0.1),
  );
  let summaryText = '';
  const usage: Usage[] = [];
  const onUsage = (record: Usage, ordinal: number): void => {
    usage.push(record);
    input.onSummaryUsage?.(record, ordinal);
  };
  if (
    Number.isFinite(summaryInputLimit) &&
    estimateDirectContext(liveRequest, input.contextWindow).renderedInputTokens <= summaryInputLimit
  ) {
    summaryText = await generateSummary(input.model, liveRequest, input.signal, (record) => onUsage(record, 1));
  } else {
    // Like the existing compactor, fall back to bounded cold-turn chunks when
    // the frozen live prefix cannot fit. Never silently drop a large chunk.
    const chunks = chunkColdHistory(plan.cold, Math.max(256, Math.floor(usable * 0.4 * 4)));
    for (const [index, chunk] of chunks.entries()) {
      input.signal.throwIfAborted();
      const summaryRequest = selfContained({
        ...input.request,
        instructions: CONTEXT_COMPACTION_INSTRUCTIONS,
        tools: [],
        input: [summaryMessage(buildContextCompactionInput(summaryText || null, JSON.stringify(chunk)))],
        maxOutputTokens: summaryOutputCap,
      });
      if (estimateDirectContext(summaryRequest, input.contextWindow).renderedInputTokens > summaryInputLimit) {
        return { kind: 'blocked', reason: 'summary_input_too_large', estimate, usage };
      }
      summaryText = await generateSummary(input.model, summaryRequest, input.signal, (record) =>
        onUsage(record, index + 1),
      );
    }
  }
  input.signal.throwIfAborted();
  const removed = plan.cold.filter((item) => item.type !== 'user_message');
  const checkpointReceipts = [...(input.checkpointReceipts ?? []), ...toolReceipts(plan.cold)];
  const checkpoint: Item = {
    type: 'summary',
    id: `compact_${randomUUID()}` as ItemId,
    text: wrapContextSummary(summaryText, checkpointReceipts.join('\n')),
    replaces: removed.map((item) => item.id),
  };
  return { history: [checkpoint, ...plan.hot], usage, checkpointReceipts };
}

/** Protect every user item verbatim; prefer the newest two user turns, then settled tool rounds. */
function planTail(
  history: readonly Item[],
  usable: number,
): { cold: readonly Item[]; hot: readonly Item[] } | 'no_complete_cold_turn' | 'single_turn_too_large' {
  const users: number[] = [];
  const rounds: number[] = [];
  const pending: string[] = [];
  for (const [index, item] of history.entries()) {
    if (item.type === 'user_message' && !pending.length) users.push(index);
    if (item.type === 'tool_call') pending.push(item.callId);
    if (item.type === 'tool_result') {
      const occurrence = pending.indexOf(item.callId);
      if (occurrence < 0) return 'no_complete_cold_turn';
      pending.splice(occurrence, 1);
      if (!pending.length) rounds.push(index + 1);
    }
  }
  if (pending.length) return 'no_complete_cold_turn';
  const hotAt = (cut: number): readonly Item[] => [
    ...history.slice(0, cut).filter((item) => item.type === 'user_message'),
    ...history.slice(cut),
  ];
  const tokensAt = (cut: number): number => Math.ceil(bytes(hotAt(cut)) / 4);
  const preferred = users.length >= 3 ? users[users.length - 2]! : 0;
  const candidates = rounds.slice(0, -1);
  const budget = Math.min(16_000, Math.max(1_000, Math.floor(usable * 0.25)), usable);
  let cut =
    preferred > 0 && tokensAt(preferred) <= budget
      ? preferred
      : candidates.find((index) => tokensAt(index) <= budget) ?? 0;
  if (!cut) {
    const latest = Math.max(preferred, candidates.at(-1) ?? 0);
    if (latest > 0 && tokensAt(latest) <= usable) cut = latest;
  }
  if (!cut) return preferred > 0 ? 'single_turn_too_large' : 'no_complete_cold_turn';
  return { cold: history.slice(0, cut), hot: hotAt(cut) };
}

async function generateSummary(
  model: Model,
  request: ModelRequest,
  signal: AbortSignal,
  onUsage: (usage: Usage) => void,
): Promise<string> {
  const messages: string[] = [];
  let deltas = '';
  let completed = false;
  for await (const event of model.stream(request, signal)) {
    signal.throwIfAborted();
    if (completed) throw new Error('Summary model emitted events after its terminal response');
    if (event.type === 'text_delta') deltas += event.delta;
    if (event.type === 'usage') onUsage(event.usage);
    if (event.type === 'item') {
      if (event.item.type === 'tool_call') throw new Error('Summary model attempted a tool call');
      if (event.item.type === 'assistant_message') {
        messages.push(
          event.item.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(''),
        );
      }
    }
    if (event.type === 'done') {
      if (event.stopReason !== 'end_turn') throw new Error(`Summary model stopped with ${event.stopReason}`);
      completed = true;
    }
  }
  const text = (messages.length ? messages.join('\n') : deltas).trim();
  if (!completed || !text) throw new Error('Summary model did not produce a complete nonempty summary');
  return text;
}

function summaryMessage(text: string): Item {
  return { type: 'user_message', id: `compact_request_${randomUUID()}` as ItemId, content: [{ type: 'text', text }] };
}

function chunkColdHistory(history: readonly Item[], maxCharacters: number): readonly (readonly Item[])[] {
  const turns: Item[][] = [];
  for (const item of history) {
    if (!turns.length || item.type === 'user_message') turns.push([]);
    turns[turns.length - 1]!.push(item);
  }
  const chunks: Item[][] = [];
  let chunk: Item[] = [];
  for (const turn of turns) {
    if (chunk.length && JSON.stringify([...chunk, ...turn]).length > maxCharacters) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(...turn);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function toolReceipts(history: readonly Item[]): readonly string[] {
  const pending: Extract<Item, { type: 'tool_call' }>[] = [];
  const receipts: string[] = [];
  for (const item of history) {
    if (item.type === 'tool_call') pending.push(item);
    if (item.type !== 'tool_result') continue;
    const index = pending.findIndex((call) => call.callId === item.callId);
    if (index < 0) continue;
    const call = pending.splice(index, 1)[0]!;
    // Preview only; exact results remain in Session's physical audit facts.
    const args = call.rawArguments ?? JSON.stringify(call.input) ?? '';
    const hash = createHash('sha256').update(args).digest('hex');
    receipts.push(
      `${call.toolName} [${call.id}; args-sha256=${hash}]: ${args.slice(0, 256)} → ${item.output.slice(0, 128)}${
        item.isError ? ' [error]' : ''
      }`,
    );
  }
  return receipts;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

function validateSettings(input: DirectCompactionInput): void {
  const { compactThreshold, compactThresholdTokens } = input.settings;
  if (!Number.isFinite(compactThreshold) || compactThreshold < 0 || compactThreshold > 1)
    throw new RangeError('Invalid compaction ratio');
  if (
    compactThresholdTokens !== null &&
    (!Number.isSafeInteger(compactThresholdTokens) || compactThresholdTokens < 1_000)
  ) {
    throw new RangeError('Compaction token threshold must be null or an integer >= 1000');
  }
  if (input.contextWindow !== undefined && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0)) {
    throw new RangeError('Context window must be a positive integer or unknown');
  }
  if (
    input.maxRequestInputTokens != null &&
    (!Number.isSafeInteger(input.maxRequestInputTokens) || input.maxRequestInputTokens <= 0)
  ) {
    throw new RangeError('Request input limit must be a positive integer or null');
  }
}
