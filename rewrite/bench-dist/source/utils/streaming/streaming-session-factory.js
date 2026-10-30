/**
 * Factory for creating streaming session helpers.
 * Extracted from use-conversation.ts to enable testing.
 */
import { createConversationEventHandler, } from '../conversation/conversation-event-handler.js';
import { createStreamingState } from '../conversation/conversation-utils.js';
import { createStreamingUpdateCoordinator } from './streaming-updater.js';
import { createMessageIdFactory } from '../message-id-factory.js';
import { StreamingSpeedTracker } from './streaming-speed-tracker.js';
function attachSettledSpeed(usage, tracker, now) {
    const settled = tracker.getSettledTps({
        completionTokens: usage.completion_tokens,
        reasoningTokens: usage.reasoning_tokens,
        completionMs: usage.completion_ms,
        endTime: now,
    });
    if (settled) {
        usage.tokens_per_second = settled.tps;
        if (settled.approximate)
            usage.tokens_per_second_estimated = true;
        else
            delete usage.tokens_per_second_estimated;
        // A burst-inflated rate describes a short tail window, not sustained
        // decode; flag it so the footer hides it instead of showing a bogus rate.
        if (settled.decodeWindowMs != null)
            usage.tokens_per_second_burst = true;
        else
            delete usage.tokens_per_second_burst;
    }
    const ttftMs = tracker.getTtftMs();
    if (ttftMs != null) {
        usage.ttft_ms = ttftMs;
    }
}
export function createStreamingSession(deps, label) {
    const now = deps.now ?? Date.now;
    const createState = deps.createStreamingState ?? createStreamingState;
    const createCoordinator = deps.createStreamingUpdateCoordinator ?? createStreamingUpdateCoordinator;
    const createEventHandler = deps.createConversationEventHandler ?? createConversationEventHandler;
    const createMessageId = deps.createMessageId ?? createMessageIdFactory(now);
    const streamingState = createState();
    // Live-row ids are claimed synchronously, before setMessages. React runs
    // functional updaters lazily, so an id assigned inside the updater is not
    // yet visible to a flush in the same burst: the flush then appends a
    // finalized copy and the late updater adds a stranded streaming row.
    const botResponseUpdater = createCoordinator((newBotText) => {
        const existingId = streamingState.currentBotMessageId;
        const messageId = existingId ?? createMessageId();
        streamingState.currentBotMessageId = messageId;
        deps.setMessages((prev) => {
            if (existingId !== null) {
                const index = prev.findIndex((msg) => msg.id === messageId);
                if (index === -1)
                    return prev;
                const current = prev[index];
                if (current.sender !== 'bot') {
                    return prev;
                }
                const next = prev.slice();
                next[index] = { ...current, status: 'streaming', text: newBotText };
                return deps.trimMessages(next);
            }
            const streamingMessage = {
                id: messageId,
                sender: 'bot',
                status: 'streaming',
                text: newBotText,
            };
            return deps.trimMessages([...prev, streamingMessage]);
        });
    }, 150);
    const reasoningUpdater = createCoordinator((newReasoningText) => {
        const existingId = streamingState.currentReasoningMessageId;
        const messageId = existingId ?? createMessageId();
        streamingState.currentReasoningMessageId = messageId;
        deps.setMessages((prev) => {
            if (existingId !== null) {
                const index = prev.findIndex((msg) => msg.id === messageId);
                if (index === -1)
                    return prev;
                const current = prev[index];
                if (current.sender !== 'reasoning') {
                    return prev;
                }
                const next = prev.slice();
                next[index] = { ...current, text: newReasoningText };
                return deps.trimMessages(next);
            }
            const reasoningMessage = {
                id: messageId,
                sender: 'reasoning',
                status: 'streaming',
                text: newReasoningText,
            };
            return deps.trimMessages([...prev, reasoningMessage]);
        });
    }, deps.reasoningThrottleMs);
    const baseEventHandler = createEventHandler({
        botResponseUpdater,
        reasoningUpdater,
        appendMessages: deps.appendMessages,
        setMessages: deps.setMessages,
        createMessageId,
        trimMessages: deps.trimMessages,
        annotateCommandMessage: deps.annotateCommandMessage,
    }, streamingState);
    const speedTracker = new StreamingSpeedTracker({ startTime: now(), charsPerToken: deps.charsPerToken });
    const notifySpeed = () => {
        if (!deps.setStreamingSpeed)
            return;
        const liveTps = speedTracker.getLiveTps(now());
        if (liveTps !== null) {
            deps.setStreamingSpeed({
                tps: liveTps,
                ttftMs: speedTracker.getTtftMs() ?? undefined,
            });
        }
    };
    const applyConversationEvent = (event) => {
        if (event.type === 'text_delta') {
            speedTracker.recordDelta(event.delta, now());
            notifySpeed();
        }
        else if (event.type === 'reasoning_delta') {
            speedTracker.recordDelta(event.delta, now());
            notifySpeed();
        }
        else if (event.type === 'tool_call_streaming_delta') {
            speedTracker.recordCumulativeChars(event.argumentCharCount, now());
            notifySpeed();
        }
        else if (event.type === 'tool_dispatched') {
            // Tool execution isn't token generation and belongs to a separate model request than
            // whatever comes next; reset so the next request's speed is measured from zero instead of
            // being diluted by tool latency or averaged together with this request.
            speedTracker.reset(now());
            // Clear the shown rate too: left in place, it labels the wait for the
            // next request as "generating" at the previous request's speed.
            deps.setStreamingSpeed?.(null);
        }
        else if (event.type === 'usage_update') {
            if (event.usage.completion_tokens) {
                speedTracker.recordUsageTokens(event.usage.completion_tokens, now());
                deps.onCharsPerTokenCalibrated?.(speedTracker.getCharsPerToken());
            }
            notifySpeed();
            attachSettledSpeed(event.usage, speedTracker, now());
            deps.loggingService.debug(`UI received streaming usage (${label})`, { usage: event.usage });
            streamingState.latestUsage = event.usage;
            deps.setLastUsage(event.usage);
        }
        else if (event.type === 'final') {
            deps.setStreamingSpeed?.(null);
            if (event.usage && !streamingState.latestUsage) {
                // No usage_update happened during this turn (e.g. a single non-tool-call request), so
                // this is the only chance to compute settled TPS for it.
                attachSettledSpeed(event.usage, speedTracker, now());
                deps.loggingService.debug(`UI received final usage (${label})`, { usage: event.usage });
                streamingState.latestUsage = event.usage;
                deps.setLastUsage(event.usage);
            }
            else if (event.usage) {
                // A usage_update already computed the correct per-request TPS for the last request in
                // this turn (before the tracker was reset for tool execution / subsequent requests).
                // final's usage is the run-cumulative total, not a fresh generation to measure — leave
                // the already-settled per-request value on streamingState.latestUsage untouched.
                deps.loggingService.debug(`UI keeping last streamed turn usage; final carries run total (${label})`, {
                    finalUsage: event.usage,
                    shownUsage: streamingState.latestUsage,
                });
            }
            else {
                deps.loggingService.debug(`UI final event has no usage (${label})`);
            }
        }
        else if (event.type === 'run_budget' && deps.setRunBudgetNotice) {
            deps.setRunBudgetNotice(event.evidence);
        }
        else if (event.type === 'codex_rate_limits' && deps.setCodexRateLimit) {
            deps.loggingService.debug(`UI received Codex rate limits (${label})`, { rateLimits: event.rateLimits });
            deps.setCodexRateLimit(event.rateLimits);
        }
        baseEventHandler(event);
    };
    return {
        botResponseUpdater,
        reasoningUpdater,
        streamingState,
        applyConversationEvent,
    };
}
//# sourceMappingURL=streaming-session-factory.js.map