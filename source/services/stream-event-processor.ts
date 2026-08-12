import type { ConversationEvent } from './conversation/conversation-events.js';
import type { ILoggingService } from './service-interfaces.js';
import { extractUsage, mergeUsage, normalizeAgentRunUsage, type NormalizedUsage } from '../utils/ai/token-usage.js';
import { captureToolCallArguments, emitCommandMessagesFromItems } from './command-message-streaming.js';
import { normalizeRunItem } from './conversation/run-item-normalizer.js';
import { createInvalidToolCallDiagnostic } from './logging/logging-contract.js';
import { parseToolCallArguments } from './tool-call-arguments.js';
import { assertAgentStream, type AgentStream } from './agent-stream.js';
import type { ToolCallStreamingDeltaEvent } from './conversation/conversation-events.js';

export interface StreamAccumulator {
  finalOutput: string;
  reasoningOutput: string;
  emittedCommandIds: Set<string>;
  latestUsage?: NormalizedUsage;
  textDeltaCount: number;
  reasoningDeltaCount: number;
  /**
   * Duration of the last compaction the provider bracketed with real frames.
   *
   * The completion notice is emitted at finalization rather than here, because its token
   * count comes from `usage`, which only arrives on `response.completed` — after the
   * compaction frames. The duration is the reverse: only the frames know it. So the
   * measurement is parked here and the two are joined at the emit site.
   */
  lastContextCompactionDurationMs?: number;
}

export const createStreamAccumulator = (): StreamAccumulator => ({
  finalOutput: '',
  reasoningOutput: '',
  emittedCommandIds: new Set<string>(),
  latestUsage: undefined,
  textDeltaCount: 0,
  reasoningDeltaCount: 0,
  lastContextCompactionDurationMs: undefined,
});

export interface StreamProcessorOptions {
  toolCallArgumentsById: Map<string, unknown>;
  emittedInvalidToolCallPackets: Set<string>;
  preserveExistingToolArgs: boolean;
  onFunctionCallItem?: (item: unknown) => void;
  onFunctionResultItem?: (item: unknown) => void;
  onRunItem?: (item: unknown) => void;
}

export interface StreamProcessorDeps {
  logger: ILoggingService;
  sessionId: string;
}

/** Consume only the closed ApplicationRunEvent protocol. */
export async function* processStreamEvents(
  stream: AgentStream,
  acc: StreamAccumulator,
  opts: StreamProcessorOptions,
  deps: StreamProcessorDeps,
): AsyncGenerator<ConversationEvent, void, void> {
  assertAgentStream(stream);
  if (!opts.preserveExistingToolArgs) opts.toolCallArgumentsById.clear();
  acc.textDeltaCount = 0;
  acc.reasoningDeltaCount = 0;

  const emitCommandMessages = (items: unknown[]) =>
    emitCommandMessagesFromItems(items, {
      toolCallArgumentsById: opts.toolCallArgumentsById,
      emittedCommandIds: acc.emittedCommandIds,
    });
  const emitText = (text: string): ConversationEvent | null => {
    if (!text) return null;
    acc.finalOutput += text;
    acc.textDeltaCount++;
    return { type: 'text_delta', delta: text, fullText: acc.finalOutput };
  };
  const emitReasoning = (text: string): ConversationEvent | null => {
    if (!text) return null;
    acc.reasoningOutput += text;
    acc.reasoningDeltaCount++;
    return { type: 'reasoning_delta', delta: text, fullText: acc.reasoningOutput };
  };

  for await (const event of stream) {
    if (event.type === 'usage_update') {
      acc.latestUsage = mergeUsage(event.usage, acc.latestUsage) ?? event.usage;
      yield { type: 'usage_update', usage: acc.latestUsage };
      continue;
    }
    if (event.type === 'cost_update') {
      yield { type: 'cost_update', record: event.record };
      continue;
    }
    if (event.type === 'codex_rate_limits') {
      yield event;
      continue;
    }
    if (event.type === 'text_delta') {
      const emitted = emitText(event.text);
      if (emitted) yield emitted;
      continue;
    }
    if (event.type === 'reasoning_delta') {
      const emitted = emitReasoning(event.text);
      if (emitted) yield emitted;
      continue;
    }
    if (event.type === 'tool_call_streaming_delta') {
      yield { ...event } satisfies ToolCallStreamingDeltaEvent;
      continue;
    }
    if (event.type === 'context_compaction_started') {
      // Surfaced live so the notice appears while the provider is actually compacting.
      // A response can carry several compaction items; the UI supersedes rather than stacks.
      yield {
        type: 'context_compaction_started',
        provider: event.provider,
        sessionId: deps.sessionId,
        ...(event.strategy ? { strategy: event.strategy } : {}),
      };
      continue;
    }
    if (event.type === 'context_compaction_completed') {
      if (event.strategy === 'local') {
        yield {
          type: 'context_compaction_completed',
          provider: event.provider,
          sessionId: deps.sessionId,
          durationMs: event.durationMs,
          strategy: 'local',
        };
        continue;
      }
      // Deliberately not yielded here — see StreamAccumulator.lastContextCompactionDurationMs.
      acc.lastContextCompactionDurationMs = event.durationMs;
      continue;
    }
    if (event.type === 'context_compaction_failed') {
      yield {
        type: 'context_compaction_failed',
        provider: event.provider,
        sessionId: deps.sessionId,
        durationMs: event.durationMs,
        errorCategory: 'request',
        strategy: 'local',
      };
      continue;
    }

    const item = event.item;
    captureToolCallArguments(item, opts.toolCallArgumentsById);
    opts.onRunItem?.(item);
    const normalizedItems = normalizeRunItem(item);
    const toolCall = normalizedItems.find((candidate) => candidate.type === 'tool_call');
    if (toolCall?.type === 'tool_call') {
      opts.onFunctionCallItem?.(item);
      if (toolCall.callId !== 'unknown-call') {
        const parsed = parseToolCallArguments(toolCall.arguments, {
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          sessionId: deps.sessionId,
          traceId: deps.logger.getCorrelationId() ?? 'trace-unknown',
        });
        if (parsed.invalidJsonDiagnostic && !opts.emittedInvalidToolCallPackets.has(toolCall.callId)) {
          opts.emittedInvalidToolCallPackets.add(toolCall.callId);
          deps.logger.error('Invalid tool call argument payload', {
            ...createInvalidToolCallDiagnostic(parsed.invalidJsonDiagnostic),
            sessionId: deps.sessionId,
            messageId: toolCall.callId,
          });
        }
        yield {
          type: 'tool_started',
          toolCallId: toolCall.callId,
          toolName: toolCall.toolName,
          arguments: parsed.arguments,
        };
        deps.logger.debug('Tool execution started', {
          eventType: 'tool_call.execution_started',
          category: 'tool',
          phase: 'execution',
          sessionId: deps.sessionId,
          traceId: deps.logger.getCorrelationId(),
          toolName: toolCall.toolName,
          toolCallId: toolCall.callId,
          messageId: toolCall.callId,
        });
      }
    }
    if (normalizedItems.some((candidate) => candidate.type === 'tool_result')) opts.onFunctionResultItem?.(item);
    for (const commandMessage of emitCommandMessages([item])) yield commandMessage;
  }

  const completedResult = await stream.completed;
  if (stream.cancelled) {
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    throw abortError;
  }
  let usageFromRawResponses: NormalizedUsage | undefined;
  for (const response of [...(stream.rawResponses ?? [])].reverse()) {
    const candidate = extractUsage(response);
    if (candidate) {
      usageFromRawResponses = candidate;
      break;
    }
  }
  const runStateUsage = normalizeAgentRunUsage(stream.runUsage);
  const finalUsage = runStateUsage || extractUsage(completedResult) || extractUsage(stream) || usageFromRawResponses;
  if (finalUsage) {
    acc.latestUsage = runStateUsage ? finalUsage : mergeUsage(finalUsage, acc.latestUsage) ?? finalUsage;
    deps.logger.debug('Usage extracted from stream completion', {
      sessionId: deps.sessionId,
      source: 'stream_completed',
      usage: acc.latestUsage,
    });
  } else {
    const completedRecord = completedResult && typeof completedResult === 'object' ? completedResult : undefined;
    deps.logger.debug('No usage found in stream completion', {
      sessionId: deps.sessionId,
      source: 'stream_completed',
      completedResultKeys: completedRecord ? Object.keys(completedRecord) : [],
      streamKeys: Object.keys(stream as unknown as Record<string, unknown>),
    });
  }

  // The terminal usage above is the run-cumulative total (every model turn in
  // the run) and stays authoritative for the terminal result, the session
  // accumulator, and persisted turn usage. The footer, though, is a
  // per-model-turn indicator: it should keep showing the most recent request's
  // own usage rather than the accumulated run total. The live `usage_update`
  // path never fires for application run-loop streams (usage is only carried on
  // terminal completions), so without this the footer falls back to the run
  // total and reads as an accumulated stat. Surface the last raw response's
  // per-request usage as one final `usage_update` so the UI's per-turn path
  // receives a true per-request figure. Providers without per-request usage
  // emit nothing here and the footer falls back to the run total as before.
  if (usageFromRawResponses) {
    yield { type: 'usage_update', usage: usageFromRawResponses };
  }
}
