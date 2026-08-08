import type { Item, ToolCall, ToolResult } from '../contracts/conversation-items.js';
import { normalizeRunItem } from './conversation/run-item-normalizer.js';

export type ToolExecutionStatus = 'started' | 'completed' | 'failed' | 'approval_required' | 'aborted';

export interface SavedToolExecution {
  turnId: string;
  callId: string;
  toolName: string;
  arguments?: unknown;
  status: ToolExecutionStatus;
  output?: unknown;
  failureReason?: string;
  startedAt: string;
  completedAt?: string;
  historyItems?: unknown[];
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

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const rawItem = (item: unknown): Record<string, unknown> | null => {
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

const hasCanonicalType = (item: unknown, type: Item['type']): boolean =>
  normalizeRunItem(item).some((candidate) => candidate.type === type);

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
  return clone(canonical?.providerItem ?? rawItem(item) ?? item);
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

const insertionIndexForEntry = (history: unknown[], entry: SavedToolExecution): number => {
  const turnNumber = turnNumberOf(entry.turnId);
  if (!turnNumber || turnNumber < 1) {
    return history.length;
  }

  let seenUserTurns = 0;
  for (let index = 0; index < history.length; index++) {
    if (!isUserMessage(history[index])) {
      continue;
    }

    seenUserTurns++;
    if (seenUserTurns === turnNumber + 1) {
      return index;
    }
  }

  return history.length;
};

const hasCallPair = (history: unknown[], callId: string): boolean => {
  let hasCall = false;
  let hasResult = false;
  for (const item of history) {
    if (callIdOf(item) !== callId) {
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

const isCompleteLedgerEntry = (entry: SavedToolExecution): boolean =>
  entry.status === 'completed' && hasRecoverableCallPair(entry);

const hasReasoningHistoryItem = (items: readonly unknown[] | undefined): boolean =>
  Array.isArray(items) && items.some((item) => hasCanonicalType(item, 'reasoning'));

const isResultHistoryItem = isToolResult;

const hasResultHistoryItem = (items: readonly unknown[] | undefined, callId: string): boolean =>
  Array.isArray(items) && items.some((item) => callIdOf(item) === callId && isResultHistoryItem(item));

const reasoningHistoryItem = (text: string): unknown => ({
  type: 'reasoning',
  content: [{ type: 'reasoning_text', text }],
  rawContent: [{ type: 'reasoning_text', text }],
});

export class ToolExecutionLedger {
  #entries: SavedToolExecution[] = [];
  #turnCounter = 0;
  #currentTurnId = 'turn-0';
  #pendingReasoningHistoryItems: unknown[] = [];

  beginTurn(): string {
    this.#turnCounter++;
    this.#currentTurnId = `turn-${this.#turnCounter}`;
    return this.#currentTurnId;
  }

  /**
   * Returns the id of the turn currently in progress, or 'turn-0' if no turn
   * has begun yet. Used by the journal and logger to tag entries with a stable
   * turn identifier that survives approval continuations.
   */
  getCurrentTurnId(): string {
    return this.#currentTurnId;
  }

  import(entries: readonly SavedToolExecution[] | undefined): void {
    this.#entries = Array.isArray(entries) ? clone(entries) : [];
    this.#turnCounter = this.#entries.length;
    this.#currentTurnId = `turn-${this.#turnCounter}`;
  }

  export(): SavedToolExecution[] {
    return clone(this.#entries);
  }

  recordReasoningText(text: string): void {
    if (!text) {
      return;
    }
    this.#pendingReasoningHistoryItems = [reasoningHistoryItem(text)];
  }

  recordFunctionCall(item: unknown): void {
    const toolCall = canonicalToolItem(item);
    if (toolCall?.type !== 'tool_call') {
      return;
    }
    const { callId } = toolCall;

    const existing = this.#entries.find((entry) => entry.callId === callId && entry.status !== 'completed');
    if (existing) {
      existing.toolName = toolCall.toolName;
      existing.arguments = toolCall.arguments;
      existing.status = 'started';
      if (!existing.historyItems || existing.historyItems.length === 0) {
        existing.historyItems = [...this.#pendingReasoningHistoryItems, providerHistoryItem(item)];
      } else if (this.#pendingReasoningHistoryItems.length > 0 && !hasReasoningHistoryItem(existing.historyItems)) {
        existing.historyItems = [...this.#pendingReasoningHistoryItems, ...existing.historyItems];
      }
      this.#pendingReasoningHistoryItems = [];
      return;
    }

    this.#entries.push({
      turnId: this.#currentTurnId,
      callId,
      toolName: toolCall.toolName,
      arguments: toolCall.arguments,
      status: 'started',
      startedAt: new Date().toISOString(),
      historyItems: [...this.#pendingReasoningHistoryItems, providerHistoryItem(item)],
    });
    this.#pendingReasoningHistoryItems = [];
  }

  recordFunctionResult(item: unknown): void {
    const toolResult = canonicalToolItem(item);
    if (toolResult?.type !== 'tool_result') {
      return;
    }
    const { callId } = toolResult;

    let entry = [...this.#entries].reverse().find((candidate) => candidate.callId === callId);
    if (!entry) {
      entry = {
        turnId: this.#currentTurnId,
        callId,
        toolName: toolResult.toolName,
        status: 'started',
        startedAt: new Date().toISOString(),
        historyItems: [],
      };
      this.#entries.push(entry);
    }

    const callItem = entry.historyItems?.find(isToolCall);
    const resultItem = providerHistoryItem(item);
    entry.status = 'completed';
    entry.output = toolResult.output;
    entry.completedAt = new Date().toISOString();
    const previousHistoryItems = entry.historyItems ?? (callItem ? [callItem] : []);
    entry.historyItems = hasResultHistoryItem(previousHistoryItems, callId)
      ? previousHistoryItems
      : [...previousHistoryItems, resultItem];
  }

  markOpenCallsAborted(reason: string, callId?: string): void {
    for (const entry of this.#entries) {
      if (callId && entry.callId !== callId) {
        continue;
      }
      if (entry.status !== 'started' && entry.status !== 'approval_required') {
        continue;
      }
      entry.status = 'aborted';
      entry.failureReason = reason;
      delete entry.historyItems;
    }
  }

  recordAbortedApproval(output: string, reason = 'Tool execution was not approved.', callId?: string): void {
    const candidates = [...this.#entries]
      .reverse()
      .filter((candidate) => candidate.status === 'started' || candidate.status === 'approval_required');

    const targets = callId ? candidates.filter((c) => c.callId === callId) : candidates;

    for (const entry of targets) {
      const callItem = entry.historyItems?.find(isToolCall);
      if (!callItem) {
        entry.status = 'aborted';
        entry.failureReason = reason;
        continue;
      }

      entry.status = 'aborted';
      entry.failureReason = reason;
      entry.completedAt = new Date().toISOString();
      entry.output = output;
      const previousHistoryItems = entry.historyItems ?? [callItem];
      entry.historyItems = hasResultHistoryItem(previousHistoryItems, entry.callId)
        ? previousHistoryItems
        : [
            ...previousHistoryItems,
            {
              type: 'function_call_output',
              callId: entry.callId,
              output,
            },
          ];
    }
  }

  /**
   * Returns call IDs for every tool call recorded in the given (or current)
   * turn, regardless of status. The chained-input filter requires the complete
   * set because the provider API requires a tool output for every tool call in
   * an assistant turn — including rejected calls, for which the SDK produces a
   * synthetic output.
   */
  activeCallIdsForTurn(turnId?: string): string[] {
    const target = turnId ?? this.#currentTurnId;
    return this.#entries.filter((entry) => entry.turnId === target).map((entry) => entry.callId);
  }

  /** Returns completed tool-result call IDs recorded during the current turn. */
  completedResultCallIdsForCurrentTurn(): string[] {
    return this.#entries
      .filter((entry) => entry.turnId === this.#currentTurnId && entry.status === 'completed')
      .map((entry) => entry.callId);
  }

  getRecoverySummary(): ToolLedgerRecoverySummary | null {
    const currentTurnEntries = this.#entries.filter((entry) => entry.turnId === this.#currentTurnId);
    if (currentTurnEntries.length === 0) {
      return null;
    }

    const recoveredCallIds = currentTurnEntries
      .filter((entry) => isCompleteLedgerEntry(entry))
      .map((entry) => entry.callId);
    const droppedCallIds = currentTurnEntries
      .filter((entry) => entry.status !== 'completed')
      .map((entry) => entry.callId);

    if (recoveredCallIds.length === 0 && droppedCallIds.length === 0) {
      return null;
    }

    return {
      recoveredCallIds,
      droppedCallIds,
      message: createRecoveryMessage(recoveredCallIds.length, droppedCallIds.length),
    };
  }
}

const createRecoveryMessage = (completedPairs: number, incompleteCalls: number): string =>
  `Recovered ${completedPairs} completed tool call/result pair(s) from a previously interrupted turn. Dropped ${incompleteCalls} incomplete tool call(s); do not assume dropped calls completed.`;

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
      const callId = callIdOf(item);
      if (callId) {
        callIdsWithCall.add(callId);
      }
    }
    if (isResultHistoryItem(item)) {
      const callId = callIdOf(item);
      if (callId) {
        callIdsWithResult.add(callId);
      }
    }
  }

  const filtered = history.filter((item) => {
    const callId = callIdOf(item);
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
): ToolLedgerReconcileResult {
  let next = clone([...history]);
  const entries = Array.isArray(ledger) ? ledger : [];
  let addedCompletedPairs = 0;
  let droppedIncompleteCalls = 0;

  for (const entry of entries) {
    if (hasRecoverableCallPair(entry)) {
      if (hasCallPair(next, entry.callId)) {
        continue;
      }
      // The persisted assistant_turn is compact: it keeps only a turn's last
      // tool result, so replayed history can hold a lone call or result for
      // this callId. Drop those fragments before inserting the authoritative
      // ledger pair, or the result is duplicated and the pair lands after a
      // result that precedes its call — a shape OpenAI-compatible providers
      // reject with 400 ("tool must be a response to a preceding message with
      // tool_calls").
      next = next.filter((item) => callIdOf(item) !== entry.callId);
      next.splice(insertionIndexForEntry(next, entry), 0, ...clone(entry.historyItems!));
      // Count both completed and aborted pairs as injected so the warning fires
      // and replaceHistory is called. Without this, aborted pairs injected from
      // markOpenCallsAborted (with synthetic error results) would not trigger a
      // history replacement, leaving dangling function_call items in the store.
      if (entry.status === 'completed' || entry.status === 'aborted') {
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
const isMalformedJsonString = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return trimmed.startsWith('{') || trimmed.startsWith('[');
  }
};

/**
 * Returns true when the history contains any `function_call` item whose
 * `arguments` field is a malformed JSON string.
 *
 * Used to decide whether provider-side conversation chaining must be
 * disabled: the previous response stored on the provider side may contain
 * the malformed tool call, making continuation via `previousResponseId`
 * unreliable. Falling back to stateless (full-history) mode lets
 * {@link sanitizeMalformedToolCallArguments} repair the arguments before
 * they reach the provider API.
 */
export function hasMalformedToolCallArguments(history: readonly unknown[]): boolean {
  return history.some((item) => {
    if (!isToolCall(item)) {
      return false;
    }
    const raw = rawItem(item);
    return isMalformedJsonString(raw?.arguments ?? raw?.args);
  });
}

/**
 * Replace malformed JSON arguments in `function_call` items with `'{}'`.
 *
 * When the model's response stream is interrupted (e.g. the server drops
 * mid-stream), it may emit a `function_call` item with truncated JSON
 * arguments. The provider API rejects requests containing invalid JSON in
 * tool call arguments, which blocks the continuation user message. This
 * function is a safety net for the stateless (full-history) path: it repairs
 * malformed argument strings so the conversation history can still be sent.
 *
 * Non-string arguments (already-parsed objects), valid JSON strings, and
 * non-`function_call` items are left untouched.
 *
 * Returns the same array reference when no changes are needed.
 */
export function sanitizeMalformedToolCallArguments(history: readonly unknown[]): unknown[] {
  let changed = false;
  const result = history.map((item): unknown => {
    if (!isToolCall(item)) {
      return item;
    }
    const raw = rawItem(item);
    if (!raw) {
      return item;
    }

    const args = raw.arguments ?? raw.args;
    if (!isMalformedJsonString(args)) {
      return item;
    }

    changed = true;
    const normalized = clone(raw) as Record<string, unknown>;
    normalized.arguments = '{}';
    delete normalized.args;
    // Preserve the wrapper structure if the original item had a rawItem wrapper
    const wrapperRecord = asRecord(item);
    if (wrapperRecord && asRecord(wrapperRecord.rawItem)) {
      return { ...wrapperRecord, rawItem: normalized };
    }
    return normalized;
  });
  return changed ? result : (history as unknown[]);
}
