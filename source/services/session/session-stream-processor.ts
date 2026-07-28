import type { ILoggingService } from '../service-interfaces.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { ConversationLogger } from '../logging/conversation-logger.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import { createStreamAccumulator, processStreamEvents, type StreamAccumulator } from '../stream-event-processor.js';
import { extractReplaySnapshot, extractFinalizationSnapshot, type StreamReplaySnapshot } from '../stream-snapshot.js';
import { collectDuplicateToolCallResultPairs } from '../input-surge-guard.js';
import { callIdOf, toolNameOf, outputOf } from '../tool-execution-ledger.js';
import { TOOL_RESULT_ITEM_TYPES } from '../../lib/chained-input-filter.js';
import type { AgentInputItem } from '@openai/agents';
import { GenerationGuard, type GenerationToken } from '../generation-guard.js';
import { RepetitionDetector, RepetitiveModelOutputError } from './repetition-detector.js';

export type StreamHistorySource = 'startStream' | 'continueRunStream' | 'abortResolution';

export type StreamFinalizationResult =
  | { kind: 'stale' }
  | { kind: 'partial' } // continuity applied; interrupted stream did not commit terminal history
  | { kind: 'committed' }; // continuity and terminal history applied

const hasConversationMessageItems = (items: unknown[]): boolean =>
  items.some((item) => {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const raw = record?.rawItem;
    const candidate = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : record;
    return candidate?.type === 'message' && typeof candidate?.role === 'string';
  });

const hasToolResultItems = (items: unknown[]): boolean =>
  items.some((item) => {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const raw = record?.rawItem;
    const candidate = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : record;
    return typeof candidate?.type === 'string' && TOOL_RESULT_ITEM_TYPES.has(candidate.type);
  });

const TOOL_ITEM_TYPES = new Set(['function_call', 'function_call_output', 'function_call_result']);

const toolItemSignature = (item: unknown): string | null => {
  const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  if (!record) {
    return null;
  }
  const raw =
    record.rawItem && typeof record.rawItem === 'object' ? (record.rawItem as Record<string, unknown>) : record;
  const type = raw.type;
  const callId = raw.callId ?? raw.call_id ?? raw.tool_call_id;
  if (typeof type !== 'string' || !TOOL_ITEM_TYPES.has(type) || typeof callId !== 'string' || !callId) {
    return null;
  }
  return `${type}:${callId}`;
};

/**
 * Drops tool call/result items the store already holds.
 *
 * An interrupted run carries its accumulated generated items forward into every
 * later resume segment, so each `continueRunStream` finalization re-offers the
 * pairs from all earlier segments. Appending them unfiltered grows history
 * quadratically until the input surge guard blocks the turn. A `type:callId`
 * pair is unique within a conversation, so an item already present is a replay,
 * not new output. Non-tool items (messages, reasoning) are never filtered.
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
                  status: entry?.status === 'failed' || entry?.status === 'aborted' ? entry.status : 'completed',
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
      this.deps.providerContinuity.update(snapshot.lastResponseId);
      warnIfStreamHistoryReplayedTools({
        logger: this.deps.logger,
        sessionId: this.deps.sessionId,
        source,
        snapshot: extractReplaySnapshot(stream),
      });
      const appendWithoutReplayedTools = (items: unknown[]): void => {
        const { kept, droppedSignatures } = dropAlreadyCommittedToolItems(
          items,
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
            offeredCount: items.length,
            droppedCount: droppedSignatures.length,
            droppedSignatures,
          });
        }
        this.deps.conversationStore.appendOutput(kept as AgentInputItem[]);
      };

      const terminal = !stream.interruptions || stream.interruptions.length === 0;
      if (terminal) {
        if (inputMode === 'delta') {
          appendWithoutReplayedTools(snapshot.output);
        } else {
          // In full-history mode, prefer message-bearing incremental items so we
          // preserve assistant text that SDK history reconstruction may strip.
          // If the incremental payload is only tool outputs, fall back to the
          // authoritative replay history instead of poisoning the canonical store.
          // When even the replay history has no messages but the incremental
          // output contains tool results, append those so retry and subsequent
          // turns can see the new tool output.
          if (hasConversationMessageItems(snapshot.output)) {
            appendWithoutReplayedTools(snapshot.output);
          } else if (hasConversationMessageItems(snapshot.newItems)) {
            appendWithoutReplayedTools(snapshot.newItems);
          } else if (hasConversationMessageItems(snapshot.history)) {
            this.deps.conversationStore.replaceHistory(snapshot.history as AgentInputItem[]);
          } else if (hasToolResultItems(snapshot.output)) {
            appendWithoutReplayedTools(snapshot.output);
          }
        }
        result = { kind: 'committed' };
      } else {
        result = { kind: 'partial' };
      }
    });

    return ran ? result : { kind: 'stale' };
  }
}
