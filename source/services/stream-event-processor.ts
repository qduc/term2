import type { ConversationEvent } from './conversation-events.js';
import type { ILoggingService } from './service-interfaces.js';
import { extractUsage, mergeUsage, normalizeAgentRunUsage, type NormalizedUsage } from '../utils/token-usage.js';
import { extractReasoningDelta, extractTextDelta } from './stream-event-parsing.js';
import { captureToolCallArguments, emitCommandMessagesFromItems } from './command-message-streaming.js';
import { createInvalidToolCallDiagnostic } from './logging-contract.js';
import { asRecord, getString } from './interruption-info.js';
import type { AgentStream } from './agent-stream.js';

export interface StreamAccumulator {
  finalOutput: string;
  reasoningOutput: string;
  emittedCommandIds: Set<string>;
  latestUsage?: NormalizedUsage;
  textDeltaCount: number;
  reasoningDeltaCount: number;
}

export const createStreamAccumulator = (): StreamAccumulator => ({
  finalOutput: '',
  reasoningOutput: '',
  emittedCommandIds: new Set<string>(),
  latestUsage: undefined,
  textDeltaCount: 0,
  reasoningDeltaCount: 0,
});

export interface StreamProcessorOptions {
  /** Per-turn map of tool-call arguments by callId. Mutated as the stream is consumed. */
  toolCallArgumentsById: Map<string, unknown>;
  /** Session-scoped set used to dedupe invalid-JSON diagnostics across turns. */
  emittedInvalidToolCallPackets: Set<string>;
  /** When false, args map is cleared at start (initial run); when true, preserved (continue/abort). */
  preserveExistingToolArgs: boolean;
}

export interface StreamProcessorDeps {
  logger: ILoggingService;
  sessionId: string;
}

export async function* processStreamEvents(
  stream: AgentStream,
  acc: StreamAccumulator,
  opts: StreamProcessorOptions,
  deps: StreamProcessorDeps,
): AsyncGenerator<ConversationEvent, void, void> {
  const { toolCallArgumentsById, emittedInvalidToolCallPackets, preserveExistingToolArgs } = opts;
  const { logger, sessionId } = deps;

  if (!preserveExistingToolArgs) {
    toolCallArgumentsById.clear();
  }

  acc.textDeltaCount = 0;
  acc.reasoningDeltaCount = 0;

  const emitText = (delta: string) => {
    if (!delta) return null;
    acc.finalOutput += delta;
    acc.textDeltaCount++;
    return { type: 'text_delta' as const, delta, fullText: acc.finalOutput };
  };

  const emitReasoning = (delta: string) => {
    if (!delta || delta.replaceAll('\n', '') === '') return null;
    acc.reasoningOutput += delta;
    acc.reasoningDeltaCount++;
    return { type: 'reasoning_delta' as const, delta, fullText: acc.reasoningOutput };
  };

  for await (const rawEvent of stream) {
    const event = asRecord(rawEvent);
    const eventData = asRecord(event?.data);
    const modelEvent = asRecord(eventData?.event);
    const eventType = getString(event, 'type');

    // Extract usage if present in any of the common locations.
    // raw_model_stream_event may nest provider payloads under .data or .data.event.
    const usage = extractUsage(rawEvent) ?? extractUsage(eventData) ?? extractUsage(modelEvent);
    if (usage) {
      const mergedUsage = mergeUsage(usage, acc.latestUsage) ?? usage;
      acc.latestUsage = mergedUsage;
      logger.debug('Usage extracted from stream event', {
        sessionId,
        source: 'stream_event',
        eventType: eventType ?? getString(eventData, 'type') ?? 'unknown',
        usage: mergedUsage,
      });
      yield { type: 'usage_update', usage: mergedUsage };
    }

    const delta1 = extractTextDelta(rawEvent);
    if (delta1) {
      const e = emitText(delta1);
      if (e) yield e;
    }
    if (eventData) {
      const delta2 = extractTextDelta(eventData);
      if (delta2) {
        const e = emitText(delta2);
        if (e) yield e;
      }
    }

    const reasoningDelta = extractReasoningDelta(rawEvent);
    if (reasoningDelta) {
      const e = emitReasoning(reasoningDelta);
      if (e) yield e;
    }

    const maybeEmitCommandMessagesFromItems = (items: unknown[]) =>
      emitCommandMessagesFromItems(items, {
        toolCallArgumentsById,
        emittedCommandIds: acc.emittedCommandIds,
      });

    if (eventType === 'run_item_stream_event') {
      const eventItem = event?.item;
      const eventItemRecord = asRecord(eventItem);
      captureToolCallArguments(eventItem, toolCallArgumentsById);

      const rawItem = asRecord(eventItemRecord?.rawItem) ?? eventItemRecord;
      if (getString(rawItem, 'type') === 'function_call') {
        const callId =
          getString(rawItem, 'callId') ??
          getString(rawItem, 'call_id') ??
          getString(rawItem, 'tool_call_id') ??
          getString(rawItem, 'toolCallId') ??
          getString(rawItem, 'id');
        if (callId) {
          const toolName = getString(rawItem, 'name') ?? getString(eventItemRecord, 'name');
          const args = rawItem?.arguments ?? rawItem?.args ?? eventItemRecord?.arguments ?? eventItemRecord?.args;

          // Providers sometimes surface arguments as a JSON string.
          // Normalize so downstream UI can reliably render parameters.
          const normalizedArgs = (() => {
            if (typeof args !== 'string') return args;
            const trimmed = args.trim();
            if (!trimmed) return args;
            try {
              return JSON.parse(trimmed);
            } catch {
              if (
                (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
                !emittedInvalidToolCallPackets.has(String(callId))
              ) {
                emittedInvalidToolCallPackets.add(String(callId));
                const diagnostic = createInvalidToolCallDiagnostic({
                  toolName: toolName ?? 'unknown',
                  toolCallId: String(callId),
                  rawPayload: trimmed,
                  normalizedToolCall: {
                    toolName: toolName ?? 'unknown',
                    toolCallId: String(callId),
                    arguments: args,
                  },
                  validationErrors: ['arguments must be valid JSON'],
                  traceId: logger.getCorrelationId() ?? 'trace-unknown',
                  retryContext: { sessionId },
                });

                logger.error('Invalid tool call argument payload', {
                  ...diagnostic,
                  sessionId,
                  messageId: String(callId),
                });
              }
              return args;
            }
          })();

          yield {
            type: 'tool_started' as const,
            toolCallId: callId,
            toolName: toolName ?? 'unknown',
            arguments: normalizedArgs,
          };

          logger.debug('Tool execution started', {
            eventType: 'tool_call.execution_started',
            category: 'tool',
            phase: 'execution',
            sessionId,
            traceId: logger.getCorrelationId(),
            toolName: toolName ?? 'unknown',
            toolCallId: String(callId),
            messageId: String(callId),
          });
        }
      }

      for (const e of maybeEmitCommandMessagesFromItems([eventItem])) {
        yield e;
      }
    } else if (
      eventType === 'tool_call_output_item' ||
      getString(asRecord(event?.rawItem), 'type') === 'function_call_output'
    ) {
      captureToolCallArguments(rawEvent, toolCallArgumentsById);
      for (const e of maybeEmitCommandMessagesFromItems([rawEvent])) {
        yield e;
      }
    }
  }

  const completedResult = await stream.completed;
  if (stream.cancelled) {
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    throw abortError;
  }
  const rawResponses = Array.isArray(stream?.rawResponses) ? stream.rawResponses : [];
  let usageFromRawResponses: NormalizedUsage | undefined;
  for (let i = rawResponses.length - 1; i >= 0; i--) {
    const candidate = extractUsage(rawResponses[i]);
    if (candidate) {
      usageFromRawResponses = candidate;
      break;
    }
  }

  // The Agents SDK keeps an authoritative, already-cumulative usage accumulator on
  // the run state (RunContext.usage), spanning every model turn in the run -
  // including turns resumed after an approval, since continuations reuse the same
  // live RunState. Trust it as the run total instead of re-summing per-turn
  // streamed snapshots (which double-counts on long, multi-turn tasks). Fall back
  // to per-response extraction for providers/runners that don't populate it.
  const runStateUsage = normalizeAgentRunUsage((stream as { state?: { usage?: unknown } })?.state?.usage);

  const finalUsage = runStateUsage || extractUsage(completedResult) || extractUsage(stream) || usageFromRawResponses;
  if (finalUsage) {
    // The run-state accumulator is the whole-run total, so it must replace (not
    // merge with) the latest per-turn snapshot to avoid inflating the count.
    acc.latestUsage = runStateUsage ? finalUsage : mergeUsage(finalUsage, acc.latestUsage) ?? finalUsage;
    const usageSource = runStateUsage
      ? 'run_state_usage'
      : extractUsage(completedResult)
      ? 'completed_result'
      : extractUsage(stream)
      ? 'stream_object'
      : 'stream_raw_responses';
    logger.debug('Usage extracted from stream completion', {
      sessionId,
      source: 'stream_completed',
      usageSource,
      usage: acc.latestUsage,
    });
  } else {
    const completedResultRecord =
      completedResult && typeof completedResult === 'object' && !Array.isArray(completedResult)
        ? (completedResult as Record<string, unknown>)
        : undefined;

    const streamRecord =
      stream && typeof stream === 'object' && !Array.isArray(stream)
        ? (stream as unknown as Record<string, unknown>)
        : undefined;

    logger.debug('No usage found in stream completion', {
      sessionId,
      source: 'stream_completed',
      completedResultType:
        completedResult === null ? 'null' : Array.isArray(completedResult) ? 'array' : typeof completedResult,
      completedResultKeys: completedResultRecord ? Object.keys(completedResultRecord) : [],
      streamKeys: streamRecord ? Object.keys(streamRecord) : [],
      completedResultHasUsagePath: {
        usage: Boolean(completedResultRecord?.usage),
        usageMetadata: Boolean(completedResultRecord?.usageMetadata),
        usage_metadata: Boolean(completedResultRecord?.usage_metadata),
        responseUsage: Boolean(asRecord(completedResultRecord?.response)?.usage),
      },
    });
  }
}
