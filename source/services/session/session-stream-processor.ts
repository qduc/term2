import type { ILoggingService } from '../service-interfaces.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { ConversationLogger } from '../logging/conversation-logger.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { OpenAIRootCheckpointLifecycleObserver } from '../openai-root-checkpoint-lifecycle-observer.js';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import { createStreamAccumulator, processStreamEvents, type StreamAccumulator } from '../stream-event-processor.js';
import { extractReplaySnapshot, extractFinalizationSnapshot, type StreamReplaySnapshot } from '../stream-snapshot.js';
import { collectDuplicateToolCallResultPairs } from '../input-surge-guard.js';
import { callIdOf, toolNameOf, outputOf } from '../tool-execution-ledger.js';
import { projectConversationMessage } from '../conversation/conversation-message-projection.js';
import { normalizeRunItem } from '../conversation/run-item-normalizer.js';
import { projectPersistedAssistantItemToProviderHistory } from '../conversation/conversation-turn-items.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { ProviderOpaqueItem } from '../../contracts/conversation-items.js';
import { GenerationGuard, type GenerationToken } from '../generation-guard.js';
import { RepetitionDetector, RepetitiveModelOutputError } from './repetition-detector.js';

export type StreamHistorySource = 'startStream' | 'continueRunStream' | 'abortResolution';

export type StreamFinalizationResult =
  | { kind: 'stale' }
  | { kind: 'partial' } // continuity applied; interrupted stream did not commit terminal history
  | { kind: 'committed' }; // continuity and terminal history applied

const hasConversationMessageItems = (items: unknown[]): boolean => items.some(projectConversationMessage);

/**
 * ApplicationRunLoop output is the canonical application event stream. Provider
 * history is kept separately in `stream.history`; only `item` events are
 * projected when a current-run snapshot is used for persistence.
 */
const isCanonicalApplicationItemEvent = (item: unknown): boolean => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const event = item as Record<string, unknown>;
  return event.type === 'item' && !!event.item && typeof event.item === 'object';
};

const canonicalProviderHistoryItems = (items: readonly unknown[]): unknown[] =>
  items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const event = item as Record<string, unknown>;
    if (event.type === 'item' && event.item && typeof event.item === 'object') return [event.item];
    if (
      event.type === 'text_delta' ||
      event.type === 'reasoning_delta' ||
      event.type === 'codex_rate_limits' ||
      event.type === 'tool_call_streaming_delta' ||
      event.type === 'usage_update'
    ) {
      return [];
    }
    return [item];
  });

const hasToolResultItems = (items: unknown[]): boolean =>
  items.some((item) => normalizeRunItem(item).some((normalized) => normalized.type === 'tool_result'));

export const lastOpenAICompaction = (items: readonly unknown[]): ProviderOpaqueItem | undefined => {
  let last: ProviderOpaqueItem | undefined;
  for (const item of items) {
    for (const normalized of normalizeRunItem(item)) {
      if (
        normalized.type === 'provider_opaque' &&
        normalized.provider === 'openai' &&
        normalized.item.type === 'compaction'
      ) {
        last = normalized;
      }
    }
  }
  return last;
};

const compactedProviderHistory = (
  existingHistory: readonly ProviderInputItem[],
  output: readonly unknown[],
): ProviderInputItem[] | undefined => {
  const compaction = lastOpenAICompaction(output);
  if (!compaction) return undefined;
  const userTurns = existingHistory.filter((item) => {
    const message = projectConversationMessage(item);
    return message?.role === 'user' && !message.isSynthetic;
  });
  return [...userTurns, projectPersistedAssistantItemToProviderHistory(compaction)];
};

const toolItemSignature = (item: unknown): string | null => {
  for (const normalized of normalizeRunItem(item)) {
    if (normalized.type === 'tool_call' || normalized.type === 'tool_result') {
      return `${normalized.type}:${normalized.callId}`;
    }
  }
  return null;
};

/**
 * Drops tool call/result items the store already holds.
 *
 * An interrupted run carries its accumulated generated items forward into every
 * later resume segment, so each `continueRunStream` finalization re-offers the
 * pairs from all earlier segments. Appending them unfiltered grows history
 * quadratically until the input surge guard blocks the turn. A canonical
 * tool-kind/call-id pair is unique within a conversation, so equivalent SDK,
 * provider, and domain representations share an identity. An item already
 * present is a replay, not new output. Non-tool items are never filtered, and
 * kept items retain their original provider representation.
 */
const dropAlreadyCommittedToolItems = (
  items: readonly unknown[],
  existingHistory: readonly unknown[],
): { kept: unknown[]; droppedSignatures: string[] } => {
  const committed = new Set<string>();
  for (const item of existingHistory) {
    const signature = toolItemSignature(item);
    if (signature) {
      committed.add(signature);
    }
  }

  const kept: unknown[] = [];
  const droppedSignatures: string[] = [];
  for (const item of items) {
    const signature = toolItemSignature(item);
    if (signature && committed.has(signature)) {
      droppedSignatures.push(signature);
      continue;
    }
    if (signature) {
      committed.add(signature);
    }
    kept.push(item);
  }

  return { kept, droppedSignatures };
};

const warnIfStreamHistoryReplayedTools = ({
  logger,
  sessionId,
  source,
  snapshot,
}: {
  logger: ILoggingService;
  sessionId: string;
  source: StreamHistorySource;
  snapshot: StreamReplaySnapshot;
}): void => {
  const { history, newItems } = snapshot;

  const historyDuplicates = collectDuplicateToolCallResultPairs(history);
  const newItemsDuplicates = collectDuplicateToolCallResultPairs(newItems);

  if (historyDuplicates.pairs === 0 && newItemsDuplicates.pairs === 0) {
    return;
  }

  logger.warn('Completed stream history contains replayed tool call/result pairs', {
    eventType: 'conversation.stream_history.replayed_tools',
    category: 'provider',
    phase: 'post_stream',
    sessionId,
    traceId: logger.getCorrelationId(),
    source,
    historyLength: history.length,
    newItemsLength: newItems.length,
    historyDuplicatePairs: historyDuplicates.pairs,
    historyMaxCopies: historyDuplicates.maxCopies,
    newItemsDuplicatePairs: newItemsDuplicates.pairs,
    newItemsMaxCopies: newItemsDuplicates.maxCopies,
  });
};

export interface SessionStreamProcessorDeps {
  logger: ILoggingService;
  sessionId: string;
  toolTracker: SessionToolTracker;
  conversationStore: ConversationStore;
  conversationLogger: ConversationLogger;
  providerContinuity: ProviderContinuity;
  /** Owned-root OpenAI lifecycle diagnostics; absent for every other client. */
  openAIRootCheckpointLifecycleObserver?: OpenAIRootCheckpointLifecycleObserver;
  generationGuard: GenerationGuard;
  /** Assistant-output journal; every raw run item is fed into it. */
  journal: AssistantTurnJournal;
  /** Cancels provider work when the output safety guard terminates a stream. */
  abortStream?: () => void;
}

export interface StreamProcessOptions {
  gen: number;
  source: StreamHistorySource;
  preserveExistingToolArgs: boolean;
  previouslyEmittedCommandIds?: Set<string>;
}

export class SessionStreamProcessor {
  constructor(private readonly deps: SessionStreamProcessorDeps) {}

  /**
   * Processes the AgentStream, records function calls/results,
   * dedupes tool started events, logs tool results, and returns the accumulator.
   */
  async *process(
    stream: AgentStream,
    options: StreamProcessOptions,
  ): AsyncGenerator<ConversationEvent, StreamAccumulator, void> {
    const acc = createStreamAccumulator();
    if (options.previouslyEmittedCommandIds) {
      acc.emittedCommandIds = new Set<string>(options.previouslyEmittedCommandIds);
    }

    if (!this.deps.generationGuard.isCurrent(options.gen)) {
      return acc;
    }

    const workingToolArguments = options.preserveExistingToolArgs
      ? new Map(this.deps.toolTracker.argumentsById)
      : new Map<string, unknown>();
    const workingInvalidPackets = new Set(this.deps.toolTracker.invalidPackets);
    const commitWorkingCaches = (): void => {
      this.deps.toolTracker.argumentsById.clear();
      for (const [callId, args] of workingToolArguments) {
        this.deps.toolTracker.argumentsById.set(callId, args);
      }
      for (const packet of workingInvalidPackets) {
        this.deps.toolTracker.invalidPackets.add(packet);
      }
    };
    let pendingLedgerReasoningText = '';
    let consumedLedgerReasoningLength = 0;
    const repetitionDetector = new RepetitionDetector();

    const generator = processStreamEvents(
      stream,
      acc,
      {
        toolCallArgumentsById: workingToolArguments,
        emittedInvalidToolCallPackets: workingInvalidPackets,
        preserveExistingToolArgs: true,
        onFunctionCallItem: (item) => {
          this.deps.generationGuard.runIfCurrent(options.gen, () => {
            const reasoningText =
              pendingLedgerReasoningText || acc.reasoningOutput.slice(consumedLedgerReasoningLength);
            if (reasoningText) {
              this.deps.toolTracker.recordReasoningText(reasoningText);
              consumedLedgerReasoningLength = acc.reasoningOutput.length;
              pendingLedgerReasoningText = '';
            }
            this.deps.toolTracker.recordFunctionCall(item);
          });
        },
        onFunctionResultItem: (item) => {
          this.deps.generationGuard.runIfCurrent(options.gen, () => {
            this.deps.toolTracker.recordFunctionResult(item);
            if (options.source !== 'startStream') {
              const cid = callIdOf(item);
              if (cid && this.deps.conversationLogger.hasSink()) {
                const entry = this.deps.toolTracker.export().find((e) => e.callId === cid);
                this.deps.conversationLogger.log({
                  type: 'tool_result',
                  callId: cid,
                  toolName: entry?.toolName ?? toolNameOf(item),
                  status:
                    entry?.status === 'failed' || entry?.status === 'aborted' || entry?.status === 'unknown'
                      ? entry.status
                      : 'completed',
                  output: entry?.output ?? outputOf(item),
                  ...(entry?.historyItems ? { historyItems: entry.historyItems } : {}),
                });
              }
            }
          });
        },
        onRunItem: (item) => {
          this.deps.generationGuard.runIfCurrent(options.gen, () => {
            this.deps.journal.recordRunItem(item);
          });
        },
      },
      { logger: this.deps.logger, sessionId: this.deps.sessionId },
    );

    const iterator = generator[Symbol.asyncIterator]();
    let closed = false;
    try {
      while (true) {
        if (!this.deps.generationGuard.isCurrent(options.gen)) {
          await iterator.return?.();
          closed = true;
          return acc;
        }

        const next = await iterator.next();
        if (!this.deps.generationGuard.isCurrent(options.gen)) {
          await iterator.return?.();
          closed = true;
          return acc;
        }
        if (next.done) {
          this.deps.generationGuard.runIfCurrent(options.gen, commitWorkingCaches);
          closed = true;
          return acc;
        }

        this.deps.generationGuard.runIfCurrent(options.gen, commitWorkingCaches);
        if (next.value.type === 'reasoning_delta') {
          pendingLedgerReasoningText = acc.reasoningOutput.slice(consumedLedgerReasoningLength);
        }
        if (next.value.type === 'text_delta' && repetitionDetector.append(next.value.delta)) {
          this.deps.logger.warn('Repeating model output detected; aborting stream', {
            eventType: 'conversation.repetitive_output_detected',
            category: 'provider',
            phase: 'stream',
            sessionId: this.deps.sessionId,
            traceId: this.deps.logger.getCorrelationId(),
            outputLength: acc.finalOutput.length,
          });
          this.deps.abortStream?.();
          throw new RepetitiveModelOutputError();
        }
        const filtered = this.deps.toolTracker.dedupeToolStarted(next.value);
        if (filtered) {
          yield filtered;
        }
      }
    } finally {
      if (!closed) {
        await iterator.return?.();
      }
    }
  }

  /**
   * Finalizes the stream outcome by updating previousResponseId,
   * checking for replayed tools, and updating the conversation store history.
   */
  finalize(
    stream: AgentStream,
    token: GenerationToken,
    inputMode: 'delta' | 'full_history',
    source: StreamHistorySource,
  ): StreamFinalizationResult {
    let result: StreamFinalizationResult = { kind: 'stale' };

    const ran = this.deps.generationGuard.runIfCurrent(token, () => {
      const snapshot = extractFinalizationSnapshot(stream);
      const projectedHistory = canonicalProviderHistoryItems(snapshot.history);
      const projectedSnapshot = {
        ...snapshot,
        history: projectedHistory,
        newItems: canonicalProviderHistoryItems(snapshot.newItems),
        output: canonicalProviderHistoryItems(snapshot.output),
      };
      const hasCanonicalApplicationItems = [...snapshot.newItems, ...snapshot.output].some((item) =>
        isCanonicalApplicationItemEvent(item),
      );
      warnIfStreamHistoryReplayedTools({
        logger: this.deps.logger,
        sessionId: this.deps.sessionId,
        source,
        snapshot: extractReplaySnapshot(stream),
      });
      const appendWithoutReplayedTools = (items: unknown[]): void => {
        const providerItems = canonicalProviderHistoryItems(items);
        const { kept, droppedSignatures } = dropAlreadyCommittedToolItems(
          providerItems,
          this.deps.conversationStore.getHistory(),
        );
        if (droppedSignatures.length > 0) {
          this.deps.logger.warn('Dropped replayed tool call/result items before committing stream history', {
            eventType: 'conversation.stream_history.replay_dropped',
            category: 'provider',
            phase: 'post_stream',
            sessionId: this.deps.sessionId,
            traceId: this.deps.logger.getCorrelationId(),
            source,
            inputMode,
            offeredCount: providerItems.length,
            droppedCount: droppedSignatures.length,
            droppedSignatures,
          });
        }
        this.deps.conversationStore.appendOutput(kept as ProviderInputItem[]);
      };

      const terminal = !stream.interruptions || stream.interruptions.length === 0;
      if (terminal) {
        const historyRevisionBeforeCommit = this.deps.conversationStore.getProviderHistorySnapshot().revision;
        const replacementHistory = compactedProviderHistory(
          this.deps.conversationStore.getHistory(),
          projectedSnapshot.output,
        );
        if (replacementHistory) {
          this.deps.conversationStore.replaceHistory(replacementHistory);
        } else if (inputMode === 'delta') {
          appendWithoutReplayedTools(projectedSnapshot.output);
        } else {
          // In full-history mode, prefer canonical current-run newItems, then
          // output, so SDK history reconstruction cannot strip assistant text.
          // If incremental payloads are only tool outputs, fall back to the
          // authoritative replay history instead of poisoning the canonical store.
          // When even replay history has no messages, append current-run tool
          // results so retry and subsequent turns can see the new tool output.
          if (hasCanonicalApplicationItems && hasConversationMessageItems(projectedSnapshot.history)) {
            this.deps.conversationStore.replaceHistory(projectedSnapshot.history as ProviderInputItem[]);
          } else if (hasConversationMessageItems(projectedSnapshot.newItems)) {
            appendWithoutReplayedTools(projectedSnapshot.newItems);
          } else if (hasConversationMessageItems(projectedSnapshot.output)) {
            appendWithoutReplayedTools(projectedSnapshot.output);
          } else if (hasConversationMessageItems(projectedSnapshot.history)) {
            this.deps.conversationStore.replaceHistory(projectedSnapshot.history as ProviderInputItem[]);
          } else if (hasToolResultItems(projectedSnapshot.newItems)) {
            appendWithoutReplayedTools(projectedSnapshot.newItems);
          } else if (hasToolResultItems(projectedSnapshot.output)) {
            appendWithoutReplayedTools(projectedSnapshot.output);
          }
        }
        // Candidate checkpoint acceptance is intentionally adjacent to the
        // authoritative terminal-history mutation. An empty/no-op terminal
        // output cannot make a candidate eligible for future ownership work.
        const postCommitSnapshot = this.deps.conversationStore.getProviderHistorySnapshot();
        const candidateWasObserved = this.deps.providerContinuity.checkpoint?.state === 'candidate';
        const historyCommitted = postCommitSnapshot.revision !== historyRevisionBeforeCommit;
        const promoted = this.deps.providerContinuity.publishTerminalResponse(
          snapshot.lastResponseId,
          historyCommitted,
          postCommitSnapshot,
        );
        // A terminal response that issued function calls opens unpaid chain
        // debt; a response with no remaining unsettled calls settles it.
        this.#syncOutstandingToolDebt();
        if (candidateWasObserved) {
          this.deps.openAIRootCheckpointLifecycleObserver?.publication(
            !historyCommitted ? 'history_not_committed' : promoted ? 'promoted' : 'candidate_not_promoted',
          );
        }
        result = { kind: 'committed' };
      } else {
        // Interrupted streams retain the established response-ID behavior, but
        // cannot corroborate an observed checkpoint without a history commit.
        this.deps.providerContinuity.update(snapshot.lastResponseId);
        // Approvals and other interruptions leave the same unpaid tool debt
        // as a clean terminal that issued function calls.
        this.#syncOutstandingToolDebt();
        result = { kind: 'partial' };
      }
    });

    return ran ? result : { kind: 'stale' };
  }

  /**
   * Mirror the tool ledger's unsettled call ids onto provider continuity so
   * the next request can refuse a text-only delta against an unpaid chain.
   */
  #syncOutstandingToolDebt(): void {
    this.deps.providerContinuity.replaceOutstandingToolCallIds(
      this.deps.toolTracker.unsettledToolCallIdsForCurrentTurn(),
    );
  }
}
