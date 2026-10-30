import { toolOccurrenceKey } from './tool-occurrence.js';
import { alignHistoryToolOccurrences } from '../tool-execution-ledger.js';
import { extractReplaySnapshot, extractFinalizationSnapshot } from '../stream-snapshot.js';
import { collectDuplicateToolCallResultPairs } from '../input-surge-guard.js';
import { projectConversationMessage } from './conversation-message-projection.js';
import { normalizeRunItem } from './run-item-normalizer.js';
import { projectPersistedAssistantItemToProviderHistory } from './conversation-turn-items.js';
import { resolveSessionId } from '../session/session-identity.js';
const hasConversationMessageItems = (items) => items.some(projectConversationMessage);
/**
 * ApplicationRunLoop output is the canonical application event stream. Provider
 * history is kept separately in `stream.history`; only `item` events are
 * projected when a current-run snapshot is used for persistence.
 */
const isCanonicalApplicationItemEvent = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return false;
    const event = item;
    return event.type === 'item' && !!event.item && typeof event.item === 'object';
};
const canonicalProviderHistoryItems = (items) => items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return [];
    const event = item;
    if (event.type === 'item' && event.item && typeof event.item === 'object')
        return [event.item];
    if (event.type === 'text_delta' ||
        event.type === 'reasoning_started' ||
        event.type === 'reasoning_delta' ||
        event.type === 'codex_rate_limits' ||
        event.type === 'tool_call_streaming_delta' ||
        event.type === 'tool_call_dispatched' ||
        event.type === 'usage_update' ||
        event.type === 'run_budget' ||
        event.type === 'context_compaction_started' ||
        event.type === 'context_compaction_completed') {
        return [];
    }
    return [item];
});
const hasToolResultItems = (items) => items.some((item) => normalizeRunItem(item).some((normalized) => normalized.type === 'tool_result'));
export const lastOpenAICompaction = (items) => {
    let last;
    for (const item of items) {
        for (const normalized of normalizeRunItem(item)) {
            if (normalized.type === 'provider_opaque' &&
                normalized.provider === 'openai' &&
                normalized.item.type === 'compaction') {
                last = normalized;
            }
        }
    }
    return last;
};
const compactedProviderHistory = (existingHistory, output) => {
    const compaction = lastOpenAICompaction(output);
    if (!compaction)
        return undefined;
    const userTurns = existingHistory.filter((item) => {
        const message = projectConversationMessage(item);
        return message?.role === 'user' && !message.isSynthetic;
    });
    const checkpoint = projectPersistedAssistantItemToProviderHistory(compaction);
    return {
        history: [...userTurns, checkpoint],
        checkpoint,
        replaced: existingHistory.length - userTurns.length,
        index: userTurns.length,
    };
};
const toolItemSignature = (item) => {
    for (const normalized of normalizeRunItem(item)) {
        if (normalized.type === 'tool_call' || normalized.type === 'tool_result') {
            return `${normalized.type}:${toolOccurrenceKey(normalized)}`;
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
 * quadratically until the input surge guard blocks the turn. An accepted
 * tool-kind/turn/call-id/occurrence is unique, so equivalent SDK,
 * provider, and domain representations share an identity. An item already
 * present is a replay, not new output. Non-tool items are never filtered, and
 * kept items retain their original provider representation.
 */
const dropAlreadyCommittedToolItems = (items, existingHistory) => {
    const committed = new Set();
    for (const item of existingHistory) {
        const signature = toolItemSignature(item);
        if (signature) {
            committed.add(signature);
        }
    }
    const kept = [];
    const droppedSignatures = [];
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
const warnIfStreamHistoryReplayedTools = ({ logger, sessionId, source, snapshot, }) => {
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
        sessionId: resolveSessionId(sessionId),
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
/** Pure selection; ConversationRecord alone applies the resulting history mutation. */
export function selectAcceptedStreamHistory(input) {
    const { stream, inputMode, source, logger, sessionId } = input;
    const history = alignHistoryToolOccurrences(input.history, input.toolLedger ?? []);
    const snapshot = extractFinalizationSnapshot(stream);
    const projected = {
        history: canonicalProviderHistoryItems(snapshot.history),
        newItems: canonicalProviderHistoryItems(snapshot.newItems),
        output: canonicalProviderHistoryItems(snapshot.output),
    };
    const terminal = !stream.interruptions || stream.interruptions.length === 0;
    warnIfStreamHistoryReplayedTools({ logger, sessionId, source, snapshot: extractReplaySnapshot(stream) });
    if (!terminal)
        return { terminal, lastResponseId: snapshot.lastResponseId };
    const append = (items) => {
        const offered = alignHistoryToolOccurrences(canonicalProviderHistoryItems(items), input.toolLedger ?? []);
        const { kept, droppedSignatures } = dropAlreadyCommittedToolItems(offered, history);
        if (droppedSignatures.length)
            logger.warn('Dropped replayed tool call/result items before committing stream history', {
                eventType: 'conversation.stream_history.replay_dropped',
                category: 'provider',
                phase: 'post_stream',
                sessionId: resolveSessionId(sessionId),
                traceId: logger.getCorrelationId(),
                source,
                inputMode,
                offeredCount: offered.length,
                droppedCount: droppedSignatures.length,
                droppedSignatures,
            });
        return [...history, ...kept];
    };
    let accepted;
    let compactionEvidence;
    const replacement = compactedProviderHistory(history, projected.output);
    const hasCanonicalItems = [...snapshot.newItems, ...snapshot.output].some(isCanonicalApplicationItemEvent);
    if (stream.historyReplacedByCompaction && projected.history.length) {
        // Acceptance cannot depend on a presentation log sink replaying assistant_turn.
        accepted = alignHistoryToolOccurrences(projected.history, input.toolLedger ?? []);
    }
    else if (replacement) {
        accepted = replacement.history;
        compactionEvidence = {
            checkpoint: replacement.checkpoint,
            replaced: replacement.replaced,
            index: replacement.index,
        };
    }
    else if (inputMode === 'delta') {
        if (projected.output.length)
            accepted = append(projected.output);
    }
    else if (hasCanonicalItems && hasConversationMessageItems(projected.history)) {
        accepted = alignHistoryToolOccurrences(projected.history, input.toolLedger ?? []);
    }
    else if (hasConversationMessageItems(projected.newItems))
        accepted = append(projected.newItems);
    else if (hasConversationMessageItems(projected.output))
        accepted = append(projected.output);
    else if (hasConversationMessageItems(projected.history))
        accepted = alignHistoryToolOccurrences(projected.history, input.toolLedger ?? []);
    else if (hasToolResultItems(projected.newItems))
        accepted = append(projected.newItems);
    else if (hasToolResultItems(projected.output))
        accepted = append(projected.output);
    return {
        terminal,
        ...(accepted ? { history: accepted } : {}),
        ...(compactionEvidence ? { compactionEvidence } : {}),
        lastResponseId: snapshot.lastResponseId,
    };
}
//# sourceMappingURL=conversation-record-stream.js.map