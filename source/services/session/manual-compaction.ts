import type { ConversationEventSink } from '../conversation/conversation-adapter.js';
import { isClassifiedCancellation } from '../retry/provider-failure-classification.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { SessionRuntime } from './session-composition.js';

/** Bounded failure reasons for a manual compaction that did not compact. Derived from the
 * typed compaction outcome (LocalCompactionOutcome 'blocked' reasons plus the runtime's
 * non-compaction kinds), never from result text. 'busy' and the pre-start refusals are not
 * failure reasons: they yield nothing_to_compact without any journal frames. */
export type ConversationCompactionFailureReason =
  | 'cancelled'
  | 'native_failed'
  | 'native_unavailable'
  | 'deferred'
  | 'single_turn_too_large'
  | 'result_still_too_large'
  | 'hot_tail_would_orphan_tool_result'
  | 'non_reducing'
  | 'summary_input_too_large'
  | 'opaque_context';

/**
 * Typed result of a manual context compaction. Consumers that must agree with the
 * journaled compaction events (the gateway command route) consume this instead of
 * inferring an outcome from the display message.
 */
export type ConversationCompactionOutcome =
  | { kind: 'compacted'; message: string; tokensBefore?: number; tokensAfter?: number }
  | { kind: 'nothing_to_compact'; message: string }
  | { kind: 'failed'; message: string; reason: ConversationCompactionFailureReason };

export interface ManualCompactionDeps {
  holdForegroundQueue: () => boolean;
  attachCompactionAbort: (abort: AbortController) => void;
  detachCompactionAbort: (abort: AbortController) => void;
  releaseForegroundQueue: (options: { pauseIfQueued: boolean }) => void;
  compactContext: SessionRuntime['compactContext'];
  getEventSink: () => ConversationEventSink | null | undefined;
  logger: ILoggingService;
  getProvider: () => string;
  getSessionId: () => string;
}

export async function runManualCompaction(deps: ManualCompactionDeps): Promise<ConversationCompactionOutcome> {
  const startedAt = Date.now();
  const provider = (): string => deps.getProvider();
  // Invariant (contract 13 §8): every context_compaction_started frame is
  // followed by exactly one terminal frame, and the command response agrees
  // in kind with that terminal frame. The runtime invokes onStarted exactly
  // when it commits to compacting — after every pre-start refusal (busy,
  // no_complete_cold_turn) has been decided — so a refusal produces no
  // frames at all and the response is nothing_to_compact.
  let startedFramePublished = false;
  const journalStarted = async (): Promise<void> => {
    startedFramePublished = true;
    await deps.getEventSink()?.({
      type: 'context_compaction_started',
      provider: provider(),
      sessionId: deps.getSessionId(),
      strategy: 'local',
    });
  };
  const journalFailure = async (errorCategory: 'validation' | 'request'): Promise<void> => {
    await deps.getEventSink()?.({
      type: 'context_compaction_failed',
      provider: provider(),
      sessionId: deps.getSessionId(),
      errorCategory,
      durationMs: Date.now() - startedAt,
      strategy: 'local',
    });
  };
  const failed = (message: string, reason: ConversationCompactionFailureReason): ConversationCompactionOutcome => {
    // A compaction that did not compact must be visible in the session log with
    // its typed reason; the journaled event alone carries no cause.
    deps.logger.warn('Manual context compaction failed', {
      eventType: 'context_compaction.failed',
      sessionId: deps.getSessionId(),
      reason,
    });
    return { kind: 'failed', message, reason };
  };
  if (!deps.holdForegroundQueue()) {
    return {
      kind: 'nothing_to_compact',
      message: 'Context compaction is available only while the conversation is idle.',
    };
  }
  const abort = new AbortController();
  deps.attachCompactionAbort(abort);
  try {
    const outcome = await deps.compactContext({ signal: abort.signal, onStarted: journalStarted });
    if (outcome.kind === 'busy') {
      return {
        kind: 'nothing_to_compact',
        message: 'Context compaction is available only while the conversation is idle.',
      };
    }
    if (outcome.kind === 'stale') throw new Error('Conversation changed while context compaction was running');
    if (outcome.kind === 'blocked') {
      if (outcome.reason === 'no_complete_cold_turn') {
        return {
          kind: 'nothing_to_compact',
          message: 'Nothing to compact: at least one complete cold turn is required.',
        };
      }
      await journalFailure('validation');
      return failed(`Context compaction was blocked: ${outcome.reason}.`, outcome.reason);
    }
    if (outcome.kind === 'failed') {
      // A codex native compaction failure is a provider-request failure, not a
      // local validation problem, and must not borrow a size reason.
      await journalFailure('request');
      return failed('Native context compaction failed.', 'native_failed');
    }
    if (outcome.kind === 'not_needed') {
      // Codex reported the native compaction unavailable ('unchanged', the
      // model's compactHistory hook is missing). That is a started compaction
      // whose result did not compact, so it fails with its own typed reason
      // instead of reading as "nothing to compact".
      await journalFailure('request');
      return failed('Native context compaction is unavailable for this model.', 'native_unavailable');
    }
    if (outcome.kind === 'deferred') {
      // Automatic-scheduling refusals never reach a manual compaction today;
      // if one ever does it is a started compaction that did not compact.
      await journalFailure('request');
      return failed('Context compaction was deferred.', 'deferred');
    }
    if (outcome.usage.inputTokens > 0 || outcome.usage.outputTokens > 0) {
      await deps.getEventSink()?.({
        type: 'usage_update',
        usage: {
          prompt_tokens: outcome.usage.inputTokens,
          completion_tokens: outcome.usage.outputTokens,
          total_tokens: outcome.usage.inputTokens + outcome.usage.outputTokens,
        },
      });
    }
    for (const record of outcome.costRecords) await deps.getEventSink()?.({ type: 'cost_update', record });
    await deps.getEventSink()?.({
      type: 'context_compaction_completed',
      provider: provider(),
      sessionId: deps.getSessionId(),
      inputTokensBefore: outcome.checkpoint.contextSummary.estimatedTokensBefore,
      inputTokensAfter: outcome.checkpoint.contextSummary.estimatedTokensAfter,
      durationMs: Date.now() - startedAt,
      strategy: 'local',
    });
    return {
      kind: 'compacted',
      message: `Context compacted locally (${outcome.checkpoint.contextSummary.estimatedTokensBefore ?? '?'} → ${
        outcome.checkpoint.contextSummary.estimatedTokensAfter ?? '?'
      } estimated tokens).`,
      ...(outcome.checkpoint.contextSummary.estimatedTokensBefore !== undefined
        ? { tokensBefore: outcome.checkpoint.contextSummary.estimatedTokensBefore }
        : {}),
      ...(outcome.checkpoint.contextSummary.estimatedTokensAfter !== undefined
        ? { tokensAfter: outcome.checkpoint.contextSummary.estimatedTokensAfter }
        : {}),
    };
  } catch (error) {
    // A throw before the runtime committed (e.g. the manual threshold is
    // unconfigured for an uncatalogued model) never published the start
    // frame, so it must not strand a terminal frame either — the RPC error
    // itself reports the failure.
    if (startedFramePublished) {
      if (abort.signal.aborted || isClassifiedCancellation(error)) {
        await journalFailure('request');
        return failed('Context compaction cancelled.', 'cancelled');
      }
      await journalFailure('request');
    }
    throw error;
  } finally {
    deps.detachCompactionAbort(abort);
    deps.releaseForegroundQueue({ pauseIfQueued: abort.signal.aborted });
  }
}
