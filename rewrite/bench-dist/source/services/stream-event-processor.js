import { extractUsage, mergeUsage, normalizeAgentRunUsage } from '../utils/ai/token-usage.js';
import { captureToolCallArguments, emitCommandMessagesFromItems } from './command-message-streaming.js';
import { normalizeRunItem } from './conversation/run-item-normalizer.js';
import { createInvalidToolCallDiagnostic } from './logging/logging-contract.js';
import { parseToolCallArguments } from './tool-call-arguments.js';
import { assertAgentStream } from './agent-stream.js';
import { ToolCallMarkerStore } from '../utils/streaming/extract-command-messages.js';
export const createStreamAccumulator = () => ({
    finalOutput: '',
    reasoningOutput: '',
    emittedCommandIds: new Set(),
    latestUsage: undefined,
    textDeltaCount: 0,
    reasoningDeltaCount: 0,
    lastContextCompactionDurationMs: undefined,
});
/** Consume only the closed ApplicationRunEvent protocol. */
export async function* processStreamEvents(stream, acc, opts, deps) {
    assertAgentStream(stream);
    const markerStore = opts.markerStore ?? new ToolCallMarkerStore();
    if (!opts.preserveExistingToolArgs)
        opts.toolCallArgumentsById.clear();
    acc.textDeltaCount = 0;
    acc.reasoningDeltaCount = 0;
    const emitCommandMessages = (items) => emitCommandMessagesFromItems(items, {
        toolCallArgumentsById: opts.toolCallArgumentsById,
        emittedCommandIds: acc.emittedCommandIds,
        markerStore,
    });
    const emitText = (text) => {
        if (!text)
            return null;
        acc.finalOutput += text;
        acc.textDeltaCount++;
        return { type: 'text_delta', delta: text, fullText: acc.finalOutput };
    };
    const emitReasoning = (text) => {
        if (!text)
            return null;
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
        if (event.type === 'run_budget') {
            yield { type: 'run_budget', evidence: event.evidence };
            continue;
        }
        if (event.type === 'codex_rate_limits') {
            yield event;
            continue;
        }
        if (event.type === 'text_delta') {
            const emitted = emitText(event.text);
            if (emitted)
                yield emitted;
            continue;
        }
        if (event.type === 'reasoning_started') {
            yield { type: 'reasoning_started', ...(event.id !== undefined ? { id: event.id } : {}) };
            continue;
        }
        if (event.type === 'reasoning_delta') {
            const emitted = emitReasoning(event.text);
            if (emitted)
                yield emitted;
            continue;
        }
        if (event.type === 'model_attempt_rollback') {
            acc.finalOutput = acc.finalOutput.slice(0, Math.max(0, acc.finalOutput.length - event.textCharacters));
            acc.reasoningOutput = acc.reasoningOutput.slice(0, Math.max(0, acc.reasoningOutput.length - event.reasoningCharacters));
            acc.textDeltaCount = Math.max(0, acc.textDeltaCount - event.textDeltas);
            acc.reasoningDeltaCount = Math.max(0, acc.reasoningDeltaCount - event.reasoningDeltas);
            continue;
        }
        if (event.type === 'tool_call_streaming_delta') {
            yield { ...event };
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
        if (event.type === 'tool_call_dispatched') {
            yield {
                type: 'tool_dispatched',
                toolCallId: event.callId,
                toolName: event.toolName,
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
        if (normalizedItems.some((candidate) => candidate.type === 'tool_result'))
            opts.onFunctionResultItem?.(item);
        for (const commandMessage of emitCommandMessages([item]))
            yield commandMessage;
    }
    const completedResult = await stream.completed;
    if (stream.cancelled) {
        const abortError = new Error('The user aborted a request.');
        abortError.name = 'AbortError';
        throw abortError;
    }
    let usageFromRawResponses;
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
    }
    else {
        const completedRecord = completedResult && typeof completedResult === 'object' ? completedResult : undefined;
        deps.logger.debug('No usage found in stream completion', {
            sessionId: deps.sessionId,
            source: 'stream_completed',
            completedResultKeys: completedRecord ? Object.keys(completedRecord) : [],
            streamKeys: Object.keys(stream),
        });
    }
    // The terminal usage above is the run-cumulative total (every model turn in
    // the run) and stays authoritative for the terminal result, the session
    // accumulator, and persisted turn usage. The footer, though, is a
    // per-model-turn indicator: it should keep showing the most recent request's
    // own usage rather than the accumulated run total. Surface the last raw
    // response's per-request usage as one final `usage_update` so the UI's
    // per-turn path receives a true per-request figure even when no live update
    // fired. Providers without per-request usage emit nothing here and the footer
    // falls back to the run total as before.
    //
    // The application run loop emits a live `usage_update` as each request
    // settles, so for those streams this restates the last request's usage
    // harmlessly. It stays for stream sources that carry usage only on the
    // terminal completion.
    if (usageFromRawResponses) {
        yield { type: 'usage_update', usage: usageFromRawResponses };
    }
}
//# sourceMappingURL=stream-event-processor.js.map