import type { ToolCall, ToolResult } from '../shared/contracts/conversation-items.js';
import { toolOccurrenceKey, toolOccurrenceMetadata } from './conversation/tool-occurrence.js';
import { normalizeRunItem } from './conversation/run-item-normalizer.js';

export type ToolExecutionStatus = 'started' | 'completed' | 'failed' | 'approval_required' | 'aborted' | 'unknown';

/** Synthetic tool result for a dispatched call whose outcome was never observed. */

/**
 * Synthetic tool result for a call interrupted by a session restart, whose
 * outcome the restart cannot observe (replay has no dispatch evidence, unlike
 * the live ledger's `dispatchedAt`). It must not assert whether the effect
 * landed — only that it is unverified.
 */
export const RESTART_UNOBSERVED_TOOL_RESULT =
  "Outcome unobserved: the session restarted before this operation's result was recorded. " +
  'Its effect may or may not have occurred. Verify the current state before any retry, and ' +
  'do not re-run non-idempotent operations blindly.';

export interface SavedToolExecution {
  turnId: string;
  callId: string;
  occurrence?: number;
  toolName: string;
  arguments?: unknown;
  status: ToolExecutionStatus;
  output?: unknown;
  failureReason?: string;
  startedAt: string;
  /** Set when the tool body is entered; distinguishes dispatch from mere call receipt. */
  dispatchedAt?: string;
  completedAt?: string;
  historyItems?: unknown[];
  /**
   * User messages in the transcript when the call was recorded. `turnId` counts
   * run attempts and drifts from the user-message count (replays add attempts;
   * import() rewinds the counter past tool-less turns), so history placement
   * uses this instead.
   */
  userTurnCount?: number;
}

export interface ToolLedgerReconcileResult {
  history: unknown[];
  addedCompletedPairs: number;
  droppedIncompleteCalls: number;
}

export interface ToolLedgerRecoverySummary {
  recoveredCallIds: string[];
  droppedCallIds: string[];
  message: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const rawItem = (item: unknown): Record<string, unknown> | null => {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  return asRecord(record.rawItem) ?? record;
};

type CanonicalToolItem = ToolCall | ToolResult;

const canonicalToolItem = (item: unknown): CanonicalToolItem | null =>
  normalizeRunItem(item).find(
    (candidate): candidate is CanonicalToolItem => candidate.type === 'tool_call' || candidate.type === 'tool_result',
  ) ?? null;

const clone = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
};

export const callIdOf = (item: unknown): string | null => {
  return canonicalToolItem(item)?.callId ?? null;
};

const isToolCall = (item: unknown): boolean => canonicalToolItem(item)?.type === 'tool_call';
const isToolResult = (item: unknown): boolean => canonicalToolItem(item)?.type === 'tool_result';

/** Type guards for history items, exported for replay-time settlement. */
export const isToolCallHistoryItem = isToolCall;
export const isToolResultHistoryItem = isToolResult;

export const toolNameOf = (item: unknown): string => {
  return canonicalToolItem(item)?.toolName ?? 'unknown';
};

export const outputOf = (item: unknown): unknown => {
  const normalized = canonicalToolItem(item);
  return normalized?.type === 'tool_result' ? normalized.output : undefined;
};

/** History remains provider-facing even when the stream hands us an SDK wrapper. */
const providerHistoryItem = (item: unknown): unknown => {
  const canonical = canonicalToolItem(item);
  return canonical
    ? { ...clone(canonical.providerItem ?? rawItem(item) ?? {}), ...toolOccurrenceMetadata(canonical) }
    : clone(rawItem(item) ?? item);
};

const turnNumberOf = (turnId: string | undefined): number | null => {
  if (typeof turnId !== 'string') {
    return null;
  }

  const match = /^turn-(\d+)$/.exec(turnId);
  if (!match) {
    return null;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
};

const isUserMessage = (item: unknown): boolean => {
  const raw = rawItem(item);
  return raw?.role === 'user' && raw?.type === 'message';
};

const insertionIndexForEntry = (history: unknown[], entry: SavedToolExecution, latestTurnNumber = 0): number => {
  const turnNumber = turnNumberOf(entry.turnId);
  if (!turnNumber || turnNumber < 1) {
    return history.length;
  }
  // `turn-N` counts run attempts, not user messages, so it drifts from the
  // user-message count (retries, tool-less turns). The latest turn is always
  // the live one and belongs after the last user message; counting user
  // messages would land it before the request it answers.
  if (turnNumber >= latestTurnNumber) {
    return history.length;
  }
  const anchor = entry.userTurnCount ?? turnNumber;

  let seenUserTurns = 0;
  for (let index = 0; index < history.length; index++) {
    if (!isUserMessage(history[index])) {
      continue;
    }

    seenUserTurns++;
    if (seenUserTurns === anchor + 1) {
      return index;
    }
  }

  return history.length;
};

const hasCallPair = (history: unknown[], entry: SavedToolExecution): boolean => {
  let hasCall = false;
  let hasResult = false;
  for (const item of history) {
    if (toolOccurrenceKey(canonicalToolItem(item) ?? { callId: '' }) !== toolOccurrenceKey(entry)) {
      continue;
    }
    if (isToolCall(item)) {
      hasCall = true;
    } else if (isToolResult(item)) {
      hasResult = true;
    }
  }
  return hasCall && hasResult;
};

const hasRecoverableCallPair = (entry: SavedToolExecution): boolean =>
  Array.isArray(entry.historyItems) && entry.historyItems.length >= 2;

/** Entries that carry a recoverable call/result pair for history projection. */

const isResultHistoryItem = isToolResult;

/**
 * Drop function_call items and function_call_output items that do not form a
 * complete pair in the history. The Responses API rejects stateless (no
 * previous_response_id) inputs containing either side on its own. This is a
 * safety net for the stateless full-history fallback path: recovery can lose
 * an in-flight output, or retain an already-consumed output after its provider
 * response chain is reset. Dropping the orphaned item keeps the request
 * self-contained rather than synthesizing misleading history.
 *
 * Returns the same array reference when no changes are needed.
 */
export function dropUnpairedFunctionCalls(history: readonly unknown[]): unknown[] {
  const callIdsWithCall = new Set<string>();
  const callIdsWithResult = new Set<string>();
  for (const item of history) {
    if (isToolCall(item)) {
      const tool = canonicalToolItem(item);
      const callId = tool ? toolOccurrenceKey(tool) : null;
      if (callId) {
        callIdsWithCall.add(callId);
      }
    }
    if (isResultHistoryItem(item)) {
      const tool = canonicalToolItem(item);
      const callId = tool ? toolOccurrenceKey(tool) : null;
      if (callId) {
        callIdsWithResult.add(callId);
      }
    }
  }

  const filtered = history.filter((item) => {
    const tool = canonicalToolItem(item);
    const callId = tool ? toolOccurrenceKey(tool) : null;
    if (isToolCall(item)) {
      return !callId || callIdsWithResult.has(callId);
    }
    if (isResultHistoryItem(item)) {
      return !callId || callIdsWithCall.has(callId);
    }
    return true;
  });

  return filtered.length === history.length ? (history as unknown[]) : filtered;
}

export function reconcileHistoryWithToolLedger(
  history: readonly unknown[],
  ledger: readonly SavedToolExecution[] | undefined,
  coveredToolOccurrences?: ReadonlySet<string>,
): ToolLedgerReconcileResult {
  const entries = normalizeToolLedgerOccurrences(ledger);
  let next = clone(alignHistoryToolOccurrences(history, entries, coveredToolOccurrences));
  let addedCompletedPairs = 0;
  let droppedIncompleteCalls = 0;
  const latestTurnNumber = entries.reduce((max, entry) => Math.max(max, turnNumberOf(entry.turnId) ?? 0), 0);

  for (const [entryIndex, entry] of entries.entries()) {
    if (coveredToolOccurrences?.has(toolOccurrenceKey(entry))) {
      continue;
    }
    if (hasRecoverableCallPair(entry)) {
      if (hasCallPair(next, entry)) {
        continue;
      }
      // The persisted assistant_turn is compact: it keeps only a turn's last
      // tool result, so replayed history can hold a lone call or result for
      // this callId. Drop those fragments before inserting the authoritative
      // ledger pair, or the result is duplicated and the pair lands after a
      // result that precedes its call — a shape OpenAI-compatible providers
      // reject with 400 ("tool must be a response to a preceding message with
      // tool_calls").
      const ownIndex = next.findIndex(
        (item) => toolOccurrenceKey(canonicalToolItem(item) ?? { callId: '' }) === toolOccurrenceKey(entry),
      );
      const laterKeys = new Set(entries.slice(entryIndex + 1).map(toolOccurrenceKey));
      const laterIndex = next.findIndex((item) =>
        laterKeys.has(toolOccurrenceKey(canonicalToolItem(item) ?? { callId: '' })),
      );
      const anchor = insertionIndexForEntry(next, entry, latestTurnNumber);
      const insertion = ownIndex >= 0 ? ownIndex : laterIndex >= 0 ? Math.min(anchor, laterIndex) : anchor;
      next = next.filter(
        (item) => toolOccurrenceKey(canonicalToolItem(item) ?? { callId: '' }) !== toolOccurrenceKey(entry),
      );
      next.splice(insertion, 0, ...clone(entry.historyItems!));
      // Count completed, aborted, and unknown pairs as injected so the warning
      // fires and replaceHistory is called. Without this, synthetic pairs for
      // interrupted calls would not trigger a history replacement, leaving
      // dangling function_call items in the store.
      if (entry.status === 'completed' || entry.status === 'aborted' || entry.status === 'unknown') {
        addedCompletedPairs++;
      }
      continue;
    }

    if (entry.status !== 'completed' && entry.status !== 'started' && entry.status !== 'approval_required') {
      droppedIncompleteCalls++;
    }
  }

  return { history: next, addedCompletedPairs, droppedIncompleteCalls };
}

/**
 * Check whether a value is a malformed JSON string — i.e. a non-empty string
 * that looks like JSON (starts with `{` or `[`) but fails to parse.
 */

/**
 * Attach known admission identities to untagged provider snapshots in order.
 * Payload matching avoids assigning an older settled sibling to a latest-only
 * segment. Explicit tags are authoritative; no provider payload is rewritten.
 */
export function alignHistoryToolOccurrences(
  history: readonly unknown[],
  ledger: readonly SavedToolExecution[],
  coveredToolOccurrences?: ReadonlySet<string>,
): unknown[] {
  const used = new Set<string>();
  // A result belongs to the call we just aligned, not an independently chosen
  // payload-equal sibling. Null also preserves an unmatched new admission.
  const pending = new Map<string, SavedToolExecution | null>();
  const comparable = (value: unknown): string => {
    if (typeof value === 'string') {
      try {
        return JSON.stringify(JSON.parse(value));
      } catch {
        return value;
      }
    }
    return JSON.stringify(value);
  };
  return history.map((item) => {
    const tool = canonicalToolItem(item);
    if (!tool) return item;
    const explicit = tool.occurrence !== undefined && tool.turnId !== undefined;
    const pairKey = JSON.stringify([tool.turnId ?? '', tool.callId]);
    const pairedResult = !explicit && tool.type === 'tool_result' && pending.has(pairKey);
    const entry = pairedResult
      ? pending.get(pairKey)
      : ledger.find((entry) => {
          const entryKey = toolOccurrenceKey(entry);
          const key = `${tool.type}:${entryKey}`;
          if (explicit) return entryKey === toolOccurrenceKey(tool);
          if (coveredToolOccurrences?.has(entryKey) || used.has(key) || entry.callId !== tool.callId) return false;
          const evidence = entry.historyItems?.flatMap(normalizeRunItem).find((item) => item.type === tool.type);
          return tool.type === 'tool_call'
            ? comparable(evidence?.type === 'tool_call' ? evidence.arguments : entry.arguments) ===
                comparable(tool.arguments)
            : comparable(evidence?.type === 'tool_result' ? evidence.output : entry.output) === comparable(tool.output);
        });
    if (tool.type === 'tool_call') pending.set(pairKey, entry ?? null);
    else pending.delete(pairKey);
    if (!entry) return item;
    used.add(`${tool.type}:${toolOccurrenceKey(entry)}`);
    return { ...(item as object), ...toolOccurrenceMetadata(entry) };
  });
}

/** Give legacy ordered entries deterministic ordinals before correlation. */
export function normalizeToolLedgerOccurrences(
  entries: readonly SavedToolExecution[] | undefined,
): SavedToolExecution[] {
  const normalized: SavedToolExecution[] = Array.isArray(entries) ? clone([...entries]) : [];
  const counters = new Map<string, number>();
  for (const entry of normalized) {
    const key = JSON.stringify([entry.turnId, entry.callId]);
    entry.occurrence ??= (counters.get(key) ?? 0) + 1;
    counters.set(key, Math.max(counters.get(key) ?? 0, entry.occurrence));
    entry.historyItems = entry.historyItems?.map((item) =>
      callIdOf(item) === entry.callId
        ? { ...(providerHistoryItem(item) as object), ...toolOccurrenceMetadata(entry) }
        : item,
    );
  }

  return normalized;
}
