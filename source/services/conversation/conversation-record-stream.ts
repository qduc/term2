import { toolOccurrenceKey } from './tool-occurrence.js';
import { alignHistoryToolOccurrences, type SavedToolExecution } from '../tool-execution-ledger.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { AgentStream } from '../agent-stream.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { ProviderOpaqueItem } from '../../contracts/conversation-items.js';
import { extractReplaySnapshot, extractFinalizationSnapshot, type StreamReplaySnapshot } from '../stream-snapshot.js';
import { collectDuplicateToolCallResultPairs } from '../input-surge-guard.js';
import { projectConversationMessage } from './conversation-message-projection.js';
import { normalizeRunItem } from './run-item-normalizer.js';
import { projectPersistedAssistantItemToProviderHistory } from './conversation-turn-items.js';
import type { SessionIdSource } from '../session/session-identity.js';
import { resolveSessionId } from '../session/session-identity.js';

export type StreamHistorySource = 'startStream' | 'continueRunStream' | 'abortResolution';

const hasConversationMessageItems = (items: unknown[]): boolean => items.some(projectConversationMessage);

/**
 * ApplicationRunLoop output is the canonical application event stream. Provider
 * history is kept separately in `stream.history`; only `item` events are
 * projected when a current-run snapshot is used for persistence.
 */
const isCanonicalApplicationItemEvent = (item: unknown): boolean => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const event = item as Record<string, unknown>;
  return event.type === 'item' && !!event.item && typeof event.item === 'object';
};

const canonicalProviderHistoryItems = (items: readonly unknown[]): unknown[] =>
  items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const event = item as Record<string, unknown>;
    if (event.type === 'item' && event.item && typeof event.item === 'object') return [event.item];
    if (
      event.type === 'text_delta' ||
      event.type === 'reasoning_started' ||
      event.type === 'reasoning_delta' ||
      event.type === 'codex_rate_limits' ||
      event.type === 'tool_call_streaming_delta' ||
      event.type === 'tool_call_dispatched' ||
      event.type === 'usage_update' ||
      event.type === 'run_budget' ||
      event.type === 'context_compaction_started' ||
      event.type === 'context_compaction_completed'
    ) {
      return [];
    }
    return [item];
  });

const hasToolResultItems = (items: unknown[]): boolean =>
  items.some((item) => normalizeRunItem(item).some((normalized) => normalized.type === 'tool_result'));

export const lastOpenAICompaction = (items: readonly unknown[]): ProviderOpaqueItem | undefined => {
  let last: ProviderOpaqueItem | undefined;
  for (const item of items) {
    for (const normalized of normalizeRunItem(item)) {
      if (
        normalized.type === 'provider_opaque' &&
        normalized.provider === 'openai' &&
        normalized.item.type === 'compaction'
      ) {
        last = normalized;
      }
    }
  }
  return last;
};

const compactedProviderHistory = (
  existingHistory: readonly ProviderInputItem[],
  output: readonly unknown[],
): ProviderInputItem[] | undefined => {
  const compaction = lastOpenAICompaction(output);
  if (!compaction) return undefined;
  const userTurns = existingHistory.filter((item) => {
    const message = projectConversationMessage(item);
    return message?.role === 'user' && !message.isSynthetic;
  });
  return [...userTurns, projectPersistedAssistantItemToProviderHistory(compaction)];
};

const toolItemSignature = (item: unknown): string | null => {
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
  sessionId: SessionIdSource;
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
export function selectAcceptedStreamHistory(input: {
  stream: AgentStream;
  toolLedger?: SavedToolExecution[];
  history: ProviderInputItem[];
  inputMode: 'delta' | 'full_history';
  source: StreamHistorySource;
  logger: ILoggingService;
  sessionId: SessionIdSource;
}): { terminal: boolean; history?: ProviderInputItem[]; lastResponseId: string | null } {
  const { stream, inputMode, source, logger, sessionId } = input;
  const history = alignHistoryToolOccurrences(input.history, input.toolLedger ?? []) as ProviderInputItem[];
  const snapshot = extractFinalizationSnapshot(stream);
  const projected = {
    history: canonicalProviderHistoryItems(snapshot.history),
    newItems: canonicalProviderHistoryItems(snapshot.newItems),
    output: canonicalProviderHistoryItems(snapshot.output),
  };
  const terminal = !stream.interruptions || stream.interruptions.length === 0;
  warnIfStreamHistoryReplayedTools({ logger, sessionId, source, snapshot: extractReplaySnapshot(stream) });
  if (!terminal) return { terminal, lastResponseId: snapshot.lastResponseId };
  const append = (items: unknown[]): ProviderInputItem[] => {
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
    return [...history, ...(kept as ProviderInputItem[])];
  };
  let accepted: ProviderInputItem[] | undefined;
  const replacement = compactedProviderHistory(history, projected.output);
  const hasCanonicalItems = [...snapshot.newItems, ...snapshot.output].some(isCanonicalApplicationItemEvent);
  if (stream.historyReplacedByCompaction && projected.history.length) {
    // Acceptance cannot depend on a presentation log sink replaying assistant_turn.
    accepted = alignHistoryToolOccurrences(projected.history, input.toolLedger ?? []) as ProviderInputItem[];
  } else if (replacement) accepted = replacement;
  else if (inputMode === 'delta') {
    if (projected.output.length) accepted = append(projected.output);
  } else if (hasCanonicalItems && hasConversationMessageItems(projected.history)) {
    accepted = alignHistoryToolOccurrences(projected.history, input.toolLedger ?? []) as ProviderInputItem[];
  } else if (hasConversationMessageItems(projected.newItems)) accepted = append(projected.newItems);
  else if (hasConversationMessageItems(projected.output)) accepted = append(projected.output);
  else if (hasConversationMessageItems(projected.history))
    accepted = alignHistoryToolOccurrences(projected.history, input.toolLedger ?? []) as ProviderInputItem[];
  else if (hasToolResultItems(projected.newItems)) accepted = append(projected.newItems);
  else if (hasToolResultItems(projected.output)) accepted = append(projected.output);
  return { terminal, ...(accepted ? { history: accepted } : {}), lastResponseId: snapshot.lastResponseId };
}
