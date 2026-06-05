import type { ConversationEvent, CodexRateLimitInfo, CodexRateLimitWindow } from './conversation-events.js';
import type { ILoggingService } from './service-interfaces.js';
import { extractUsage, mergeUsage, normalizeAgentRunUsage, type NormalizedUsage } from '../utils/token-usage.js';
import { extractReasoningDelta, extractTextDelta } from './stream-event-parsing.js';
import { captureToolCallArguments, emitCommandMessagesFromItems } from './command-message-streaming.js';
import { createInvalidToolCallDiagnostic } from './logging-contract.js';
import { asRecord, getString } from './interruption-info.js';
import { parseToolCallArguments } from './tool-call-arguments.js';
import type { AgentStream } from './agent-stream.js';
import type { ToolCallStreamingDeltaEvent } from './conversation-events.js';

function normalizeCodexRateLimitWindow(obj: unknown): CodexRateLimitWindow | undefined {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  const used_percent = typeof rec.used_percent === 'number' ? rec.used_percent : undefined;
  const window_minutes = typeof rec.window_minutes === 'number' ? rec.window_minutes : undefined;
  const reset_after_seconds = typeof rec.reset_after_seconds === 'number' ? rec.reset_after_seconds : undefined;
  const reset_at = typeof rec.reset_at === 'number' ? rec.reset_at : undefined;

  if (
    used_percent !== undefined &&
    window_minutes !== undefined &&
    reset_after_seconds !== undefined &&
    reset_at !== undefined
  ) {
    return {
      used_percent,
      window_minutes,
      reset_after_seconds,
      reset_at,
    };
  }
  return undefined;
}

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
  /** Optional durable recovery hook for provider function_call items. */
  onFunctionCallItem?: (item: unknown) => void;
  /** Optional durable recovery hook for provider function_call_result/output items. */
  onFunctionResultItem?: (item: unknown) => void;
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

  /** Tracks tool names from response.output_item.added events (Responses API). */
  const streamingToolNamesByIndex = new Map<number, string>();
  /** Accumulated argument character count for each streaming tool call by index. */
  const streamingToolArgCharCounts = new Map<number, number>();

  const emitText = (delta: string) => {
    if (!delta) return null;
    acc.finalOutput += delta;
    acc.textDeltaCount++;
    return { type: 'text_delta' as const, delta, fullText: acc.finalOutput };
  };

  const emitReasoning = (delta: string) => {
    if (!delta) return null;
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

    // Intercept Codex rate-limits frames (e.g. codex.rate_limits) from the
    // upstream provider stream so the UI can display them in the status bar.
    const rawRateLimit =
      getString(event, 'type') === 'codex.rate_limits'
        ? event
        : getString(eventData, 'type') === 'codex.rate_limits'
        ? eventData
        : getString(modelEvent, 'type') === 'codex.rate_limits'
        ? modelEvent
        : undefined;

    if (rawRateLimit) {
      const rl = asRecord(rawRateLimit);
      const rlData = asRecord(rl?.rate_limits) ?? rl;
      const primary = normalizeCodexRateLimitWindow(rlData?.primary);
      const secondary = normalizeCodexRateLimitWindow(rlData?.secondary);

      if (primary !== undefined || secondary !== undefined) {
        const rateLimits: CodexRateLimitInfo = {
          allowed: Boolean(rlData?.allowed),
          limit_reached: Boolean(rlData?.limit_reached),
          ...(primary !== undefined ? { primary } : {}),
          ...(secondary !== undefined ? { secondary } : {}),
        };
        logger.debug('Codex rate limits extracted from stream event', {
          sessionId,
          source: 'codex_rate_limits',
          rateLimits,
        });
        yield { type: 'codex_rate_limits' as const, rateLimits };
      }
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

    // --- Detect tool call argument streaming (before tool_started fires) ---
    //
    // Responses API: response.output_item.added fires when the model starts a
    // function_call; response.output_item.delta carries argument fragments.
    // Chat Completions API: choices[].delta.tool_calls carries fragments.
    {
      const meType = getString(modelEvent, 'type');
      const edType = getString(eventData, 'type');

      // Capture tool name from the initial item-added event (Responses API).
      if (meType === 'response.output_item.added' || edType === 'response.output_item.added') {
        const addedSrc = meType === 'response.output_item.added' ? modelEvent : eventData;
        const addedItem = asRecord(addedSrc?.output_item) ?? asRecord(addedSrc?.item);
        if (getString(addedItem, 'type') === 'function_call') {
          const idx =
            typeof (addedSrc as Record<string, unknown>)?.output_index === 'number'
              ? ((addedSrc as Record<string, unknown>).output_index as number)
              : -1;
          const name = getString(addedItem, 'name');
          if (idx >= 0 && name) streamingToolNamesByIndex.set(idx, name);
        }
      }

      // Detect argument delta from Responses API.
      if (meType === 'response.output_item.delta' || edType === 'response.output_item.delta') {
        const deltaSrc = meType === 'response.output_item.delta' ? modelEvent : eventData;
        const delta = asRecord(deltaSrc?.delta);
        if (delta && typeof delta.arguments === 'string' && delta.arguments) {
          const idx =
            typeof (deltaSrc as Record<string, unknown>)?.output_index === 'number'
              ? ((deltaSrc as Record<string, unknown>).output_index as number)
              : -1;
          if (idx >= 0) {
            const prev = streamingToolArgCharCounts.get(idx) ?? 0;
            const next = prev + (delta.arguments as string).length;
            streamingToolArgCharCounts.set(idx, next);
            const toolName = streamingToolNamesByIndex.get(idx);
            yield {
              type: 'tool_call_streaming_delta',
              toolName,
              argumentCharCount: next,
            } satisfies ToolCallStreamingDeltaEvent;
          }
        }
      }

      // Detect argument delta from Chat Completions API.
      // modelEvent is the ChatCompletionChunk; tool_calls live under choices[].delta.tool_calls.
      {
        const choices = modelEvent?.choices ?? eventData?.choices;
        if (Array.isArray(choices)) {
          for (const choice of choices) {
            const delta = asRecord(choice?.delta);
            const toolCalls = delta?.tool_calls;
            if (Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                const fn = asRecord(tc?.function);
                if (fn) {
                  // Track tool name from any chunk (first chunk has it).
                  const name = getString(fn, 'name');
                  if (name) streamingToolNamesByIndex.set(tc?.index ?? 0, name);
                  if (typeof fn.arguments === 'string' && fn.arguments) {
                    const tcIndex = tc?.index ?? 0;
                    const prev = streamingToolArgCharCounts.get(tcIndex) ?? 0;
                    const next = prev + (fn.arguments as string).length;
                    streamingToolArgCharCounts.set(tcIndex, next);
                    yield {
                      type: 'tool_call_streaming_delta',
                      toolName: streamingToolNamesByIndex.get(tcIndex),
                      argumentCharCount: next,
                    } satisfies ToolCallStreamingDeltaEvent;
                  }
                }
              }
            }
          }
        }
      }
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
        opts.onFunctionCallItem?.(eventItem);
        const callId =
          getString(rawItem, 'callId') ??
          getString(rawItem, 'call_id') ??
          getString(rawItem, 'tool_call_id') ??
          getString(rawItem, 'toolCallId') ??
          getString(rawItem, 'id');
        if (callId) {
          const toolName = getString(rawItem, 'name') ?? getString(eventItemRecord, 'name');
          const args = rawItem?.arguments ?? rawItem?.args ?? eventItemRecord?.arguments ?? eventItemRecord?.args;

          const parseResult = parseToolCallArguments(args, {
            callId: String(callId),
            toolName: toolName ?? 'unknown',
            sessionId,
            traceId: logger.getCorrelationId() ?? 'trace-unknown',
          });

          if (parseResult.invalidJsonDiagnostic && !emittedInvalidToolCallPackets.has(String(callId))) {
            emittedInvalidToolCallPackets.add(String(callId));
            const diagnostic = createInvalidToolCallDiagnostic(parseResult.invalidJsonDiagnostic);
            logger.error('Invalid tool call argument payload', {
              ...diagnostic,
              sessionId,
              messageId: String(callId),
            });
          }

          yield {
            type: 'tool_started' as const,
            toolCallId: callId,
            toolName: toolName ?? 'unknown',
            arguments: parseResult.arguments,
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

      const rawItemType = getString(rawItem, 'type');
      if (
        rawItemType === 'function_call_result' ||
        rawItemType === 'function_call_output' ||
        rawItemType === 'function_call_output_result' ||
        rawItemType === 'tool_call_output_item'
      ) {
        opts.onFunctionResultItem?.(eventItem);
      }

      for (const e of maybeEmitCommandMessagesFromItems([eventItem])) {
        yield e;
      }
    } else if (
      eventType === 'tool_call_output_item' ||
      getString(asRecord(event?.rawItem), 'type') === 'function_call_output'
    ) {
      captureToolCallArguments(rawEvent, toolCallArgumentsById);
      opts.onFunctionResultItem?.(rawEvent);
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
