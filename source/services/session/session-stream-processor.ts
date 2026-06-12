import type { ILoggingService } from '../service-interfaces.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { ConversationLogger } from '../logging/conversation-logger.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { createStreamAccumulator, processStreamEvents, type StreamAccumulator } from '../stream-event-processor.js';
import { extractReplaySnapshot, extractFinalizationSnapshot, type StreamReplaySnapshot } from '../stream-snapshot.js';
import { collectDuplicateToolCallResultPairs } from '../input-surge-guard.js';
import { callIdOf, toolNameOf, outputOf } from '../tool-execution-ledger.js';
import type { AgentInputItem } from '@openai/agents';
import { GenerationGuard, type GenerationToken } from '../generation-guard.js';

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
  const { history, newItems, generatedItems } = snapshot;

  const historyDuplicates = collectDuplicateToolCallResultPairs(history);
  const newItemsDuplicates = collectDuplicateToolCallResultPairs(newItems);
  const stateGeneratedItemsDuplicates = collectDuplicateToolCallResultPairs(generatedItems);

  if (historyDuplicates.pairs === 0 && newItemsDuplicates.pairs === 0 && stateGeneratedItemsDuplicates.pairs === 0) {
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
    stateGeneratedItemsLength: generatedItems.length,
    historyDuplicatePairs: historyDuplicates.pairs,
    historyMaxCopies: historyDuplicates.maxCopies,
    newItemsDuplicatePairs: newItemsDuplicates.pairs,
    newItemsMaxCopies: newItemsDuplicates.maxCopies,
    stateGeneratedItemsDuplicatePairs: stateGeneratedItemsDuplicates.pairs,
    stateGeneratedItemsMaxCopies: stateGeneratedItemsDuplicates.maxCopies,
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

    const generator = processStreamEvents(
      stream,
      acc,
      {
        toolCallArgumentsById: workingToolArguments,
        emittedInvalidToolCallPackets: workingInvalidPackets,
        preserveExistingToolArgs: true,
        onFunctionCallItem: (item) => {
          this.deps.generationGuard.runIfCurrent(options.gen, () => {
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
      const terminal = !stream.interruptions || stream.interruptions.length === 0;
      if (terminal) {
        if (inputMode === 'delta') {
          this.deps.conversationStore.appendOutput(snapshot.output as AgentInputItem[]);
        } else {
          // In full-history mode, prefer message-bearing incremental items so we
          // preserve assistant text that SDK history reconstruction may strip.
          // If the incremental payload is only tool outputs, fall back to the
          // authoritative replay history instead of poisoning the canonical store.
          if (hasConversationMessageItems(snapshot.output)) {
            this.deps.conversationStore.appendOutput(snapshot.output as AgentInputItem[]);
          } else if (hasConversationMessageItems(snapshot.newItems)) {
            this.deps.conversationStore.appendOutput(snapshot.newItems as AgentInputItem[]);
          } else if (snapshot.history.length > 0) {
            this.deps.conversationStore.replaceHistory(snapshot.history as AgentInputItem[]);
          } else if (snapshot.output.length > 0) {
            this.deps.conversationStore.appendOutput(snapshot.output as AgentInputItem[]);
          } else if (snapshot.newItems.length > 0) {
            this.deps.conversationStore.appendOutput(snapshot.newItems as AgentInputItem[]);
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
