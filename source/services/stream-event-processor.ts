import type { ConversationEvent } from './conversation/conversation-events.js';
import type { ILoggingService } from './service-interfaces.js';
import { extractUsage, mergeUsage, normalizeAgentRunUsage, type NormalizedUsage } from '../utils/ai/token-usage.js';
import { captureToolCallArguments, emitCommandMessagesFromItems } from './command-message-streaming.js';
import { normalizeRunItem } from './conversation/run-item-normalizer.js';
import { createInvalidToolCallDiagnostic } from './logging/logging-contract.js';
import { parseToolCallArguments } from './tool-call-arguments.js';
import type { AgentStream } from './agent-stream.js';
import type { ToolCallStreamingDeltaEvent } from './conversation/conversation-events.js';

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
}
