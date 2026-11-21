/**
 * Term2 host policy the portable harness takes through `TurnDeps` seams: user-facing wording, the
 * `[Mode Notice]` convention, compaction prompts and estimate, which user messages Session wrote itself,
 * and which provider items are native compaction checkpoints. `harness.ts` applies it to every turn.
 */
import type { Item, ProviderOpaqueItem, TurnDeps, TurnText } from '@qduc/agent-core';
import { BACKGROUND_TASK_UPDATE_PREFIX } from '../notifications.js';
import { term2CompactionPrompts } from './compaction-prompts.js';
import { term2ContextEstimator } from './context-estimate.js';

const MODE_NOTICE_PREFIX = '[Mode Notice] ';
const RETRY_HINT = '\n\nType /retry turn to try again, or send a new message to move on.';

function attemptCount(attempts: number): string {
  return `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
}

const UNREACHED_LEAD = /^Could not reach (.+) after (\d+) attempts?\. No model response was received\./;

/** The notice stored with a turn's terminal fact: the engine's own, with a retries-exhausted lead made precise. */
export function terminalNotice(result: {
  readonly notice?: string;
  readonly kind: string;
  readonly error?: { readonly kind: string };
}): string {
  const notice = result.notice ?? '';
  return result.kind === 'failed' && result.error ? describeRetriesExhausted(notice, result.error) : notice;
}

/**
 * The engine's `retriesExhausted` seam receives only the provider and the attempt count, so it must
 * assume the provider was unreachable. The failed turn's error says more: only a `network` failure means
 * no response arrived; any other kind is the provider answering with an error. Rewrites that lead.
 */
function describeRetriesExhausted(notice: string, error: { readonly kind: string }): string {
  if (error.kind === 'network') return notice;
  const match = UNREACHED_LEAD.exec(notice);
  if (!match) return notice;
  const [lead, provider, attempts] = match as unknown as [string, string, string];
  return `${provider} answered with an error after ${attemptCount(
    Number(attempts),
  )}, so no model response was produced.${notice.slice(lead.length)}`;
}

const term2TurnText: TurnText = {
  // Every harness notice is admitted as a user message with this prefix.
  notice: (text) => `${MODE_NOTICE_PREFIX}${text}`,
  retriesExhausted: (provider, attempts) =>
    `Could not reach ${provider} after ${attemptCount(attempts)}. No model response was received.${RETRY_HINT}`,
  compactionHardFit: (reason) =>
    `${
      reason === 'single_turn_too_large'
        ? 'The protected recent conversation is too large to fit the configured context window'
        : 'The compacted conversation is still too large to fit the configured context window'
    }. Compaction did not reduce the existing context. In the interactive app, if this session has a finalized assistant reply, /handoff can copy that latest completed reply into a fresh session. Otherwise, start a fresh session and include the current session ID plus a short summary of the unfinished request.`,
  compactionNoColdTurn: () =>
    'Local compaction cannot shorten this history yet: it needs an older completed turn or settled tool rounds and preserves all user requests. ' +
    'Continue the current work; keep outputs concise and save durable progress. If session_rollover is available, consider it at a safe idle boundary; live background work survives rollover, so do not wait for it solely to rotate. Do not repeat completed work or manufacture user turns to force compaction.',
  requestInputLimit: (detail) =>
    detail.limitSource === 'model_capacity'
      ? `Request cannot fit the known model capacity (input budget ${detail.inputBudget}, output reserve ${detail.outputReserve}, estimation reserve ${detail.estimationReserve}, capacity ${detail.capacity}). Work is retained. Compact, choose a larger-capacity model, or lower an explicit output allocation before resuming.`
      : `Request input exceeds configured ceiling (${detail.estimated} > ${detail.limit} tokens). Work is retained. Compact, use a concise artifact-backed handoff, or explicitly raise agent.maxRequestInputTokens before resuming.`,
  compactionThresholdRequired: () => 'Set agent.contextCompaction.compactThresholdTokens for an uncatalogued model',
};

/**
 * Session's background deliveries are task data, not a new human turn, so local compaction may summarize
 * them. `Background shell_output` is the wording older Term2 versions persisted for shell watches.
 */
function isHostMessage(item: Extract<Item, { type: 'user_message' }>): boolean {
  const text = item.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return (
    text.startsWith(BACKGROUND_TASK_UPDATE_PREFIX) ||
    text.startsWith('Background shell_output (task data, not a human instruction or permission):')
  );
}

/** Tool receipts show what the host ran, preferred over the model's description of it. */
function receiptArguments(_toolName: string, args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    for (const key of ['command', 'path', 'file_path', 'url', 'query', 'description'] as const) {
      if (typeof parsed[key] === 'string') return parsed[key];
    }
  } catch {
    // Not JSON: show it as it came.
  }
  return args;
}

/** The OpenAI Responses `compaction` item stands in for all history before it. */
function isProviderCheckpoint(item: ProviderOpaqueItem): boolean {
  return item.provider === 'openai' && item.item.type === 'compaction';
}

/** Fill Term2's seams without overriding any a caller set explicitly. */
export function withTerm2Host<AppCtx>(deps: TurnDeps<AppCtx>): TurnDeps<AppCtx> {
  return {
    ...deps,
    text: { ...term2TurnText, ...deps.text },
    isProviderCheckpoint: deps.isProviderCheckpoint ?? isProviderCheckpoint,
    ...(deps.compaction
      ? {
          compaction: {
            estimator: term2ContextEstimator,
            prompts: term2CompactionPrompts,
            isHostMessage,
            receiptArguments,
            ...deps.compaction,
          },
        }
      : {}),
  };
}
