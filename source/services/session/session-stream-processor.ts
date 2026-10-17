import { normalizeRunItem } from '../conversation/run-item-normalizer.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { createStreamAccumulator, processStreamEvents, type StreamAccumulator } from '../stream-event-processor.js';
import { GenerationGuard } from '../generation-guard.js';
import { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
import type { SessionIdSource } from './session-identity.js';
import { resolveSessionId } from './session-identity.js';
import type { StreamHistorySource } from '../conversation/conversation-record-stream.js';
export type { StreamHistorySource } from '../conversation/conversation-record-stream.js';

export interface SessionStreamProcessorDeps {
  logger: ILoggingService;
  sessionId: SessionIdSource;
  toolTracker: SessionToolTracker;
  generationGuard: GenerationGuard;
  /** Cancels provider work when the output safety guard terminates a stream. */
  abortStream?: () => void;
  toolCallMarkers?: ToolCallMarkerStore;
}

export interface StreamProcessOptions {
  gen: number;
  source: StreamHistorySource;
  preserveExistingToolArgs: boolean;
  previouslyEmittedCommandIds?: Set<string>;
}

export class SessionStreamProcessor {
  readonly #toolCallMarkers: ToolCallMarkerStore;

  constructor(private readonly deps: SessionStreamProcessorDeps) {
    this.#toolCallMarkers = deps.toolCallMarkers ?? new ToolCallMarkerStore();
  }

  /**
   * Projects accepted events, dedupes display events and returns presentation data.
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
        markerStore: this.#toolCallMarkers,
        onFunctionResultItem: (item) => {
          for (const normalized of normalizeRunItem(item)) {
            if (normalized.type === 'tool_result') this.deps.toolTracker.noteResultObserved(normalized.callId);
          }
        },
      },
      { logger: this.deps.logger, sessionId: resolveSessionId(this.deps.sessionId) },
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
          // An admitted tool_started is a new execution. If the provider reused the id of an earlier,
          // settled call, that call's command messages must not hide this execution's result, and
          // that call's rejection must not mark it.
          if (filtered.type === 'tool_started') {
            for (const id of this.deps.toolTracker.takeCommandMessageIdsOfEarlierExecution(filtered.toolCallId)) {
              acc.emittedCommandIds.delete(id);
            }
            this.#toolCallMarkers.forgetApprovalRejection(filtered.toolCallId);
          }
          if (filtered.type === 'command_message') this.deps.toolTracker.noteCommandMessageEmitted(filtered.message);
          yield filtered;
        }
      }
    } finally {
      if (!closed) {
        await iterator.return?.();
      }
    }
  }
}
