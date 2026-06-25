import type { AgentInputItem } from '@openai/agents';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import {
  reconcileHistoryWithToolLedger,
  ToolExecutionLedger,
  type SavedToolExecution,
  callIdOf,
} from '../tool-execution-ledger.js';
import type { ConversationStore } from '../conversation/conversation-store.js';

/**
 * Owns all tool-tracking state for a conversation session.
 *
 * This includes the tool execution ledger, tool-call arguments cache,
 * and deduplication sets for invalid packets and started events.
 *
 * The session delegates to this tracker rather than interleaving
 * tool-tracking logic with other concerns.
 */
export class SessionToolTracker {
  private toolLedger = new ToolExecutionLedger();
  private toolCallArgumentsById = new Map<string, unknown>();
  private emittedInvalidToolCallPackets = new Set<string>();
  private emittedToolStartedCallIds = new Set<string>();
  private emittedSubagentToolStartedIds = new Set<string>();

  constructor(private conversationStore: ConversationStore) {}

  /**
   * Get the underlying ledger for direct access when needed.
   */
  get ledger(): ToolExecutionLedger {
    return this.toolLedger;
  }

  /**
   * Get the tool-call arguments cache for direct access when needed.
   */
  get argumentsById(): Map<string, unknown> {
    return this.toolCallArgumentsById;
  }

  /**
   * Get the invalid packets set for direct access when needed.
   */
  get invalidPackets(): Set<string> {
    return this.emittedInvalidToolCallPackets;
  }

  /**
   * Begin a new turn in the ledger.
   */
  beginTurn(): void {
    this.toolLedger.beginTurn();
  }

  /**
   * Returns the id of the turn currently in progress, or 'turn-0' if no turn
   * has begun yet. Exposed for the journal and logger to tag entries with a
   * stable turn identifier that survives approval continuations.
   */
  getCurrentTurnId(): string {
    return this.toolLedger.getCurrentTurnId();
  }

  /**
   * Returns call IDs for every tool call recorded in the current turn,
   * regardless of status. The chained-input filter requires the complete set
   * because the provider API requires a tool output for every tool call in an
   * assistant turn — including rejected calls, for which the SDK produces a
   * synthetic output.
   */
  activeCallIdsForCurrentTurn(): string[] {
    return this.toolLedger.activeCallIdsForTurn();
  }

  /**
   * Export the current ledger state.
   */
  export(): SavedToolExecution[] {
    return this.toolLedger.export();
  }

  /**
   * Import a saved ledger state.
   */
  import(entries: SavedToolExecution[] | undefined): void {
    this.toolLedger.import(entries);
  }

  /**
   * Record a function call in the ledger.
   */
  recordFunctionCall(item: unknown): void {
    this.toolLedger.recordFunctionCall(item);
  }

  /**
   * Record reasoning that should be replayed before the next tool call.
   */
  recordReasoningText(text: string): void {
    this.toolLedger.recordReasoningText(text);
  }

  /**
   * Record a function result in the ledger.
   */
  recordFunctionResult(item: unknown): void {
    this.toolLedger.recordFunctionResult(item);
  }

  /**
   * Record an aborted approval in the ledger.
   */
  recordAbortedApproval(output: string, errorMessage: string, callId?: string): void {
    this.toolLedger.recordAbortedApproval(output, errorMessage, callId);
  }

  /**
   * Mark open calls as aborted with the given error message.
   */
  markOpenCallsAborted(errorMessage: string, callId?: string): void {
    this.toolLedger.markOpenCallsAborted(errorMessage, callId);
  }

  /**
   * Get a recovery summary if there are recovered/dropped calls.
   */
  getRecoverySummary(): { recoveredCallIds: string[]; droppedCallIds: string[]; message: string } | null {
    return this.toolLedger.getRecoverySummary();
  }

  /**
   * Restore completed tool ledger entries from a snapshot.
   */
  restoreCompletedEntries(snapshot: SavedToolExecution[]): void {
    const merged = [...snapshot];
    const indexByCallId = new Map<string, number>();

    merged.forEach((entry, index) => {
      indexByCallId.set(entry.callId, index);
    });

    for (const entry of this.toolLedger.export()) {
      if (entry.status !== 'completed') {
        continue;
      }

      const existingIndex = indexByCallId.get(entry.callId);
      if (existingIndex !== undefined) {
        merged[existingIndex] = entry;
        continue;
      }

      indexByCallId.set(entry.callId, merged.length);
      merged.push(entry);
    }

    this.toolLedger.import(merged);
  }

  /**
   * Recover approved tool results from stream state.
   *
   * In chaining/delta mode the conversation store never receives
   * function_call_output items (they are server-managed deltas). They live
   * transiently in the SDK RunState's _generatedItems. When a transport
   * failure triggers a stateless full-history retry, this method bridges
   * those outputs from _generatedItems into the ledger and store.
   *
   * All function_call_output items in _generatedItems are recovered, not just
   * those matching expectedCallIds: a single failure can leave multiple
   * cycles' outputs un-transferred, and filtering by expectedCallIds (the
   * latest delta's calls) would drop earlier cycles' outputs — leaving
   * unpaired function_calls that the Responses API rejects with
   * "No tool output found for function call".
   */
  recoverApprovedResultsFromState(state: unknown, expectedCallIds: readonly string[]): void {
    // expectedCallIds is retained as a guard: when empty there are no pending
    // tool results to recover, so skip the work entirely.
    const hasExpected = expectedCallIds.some((callId) => typeof callId === 'string' && callId.length > 0);
    if (!hasExpected) {
      return;
    }

    const generatedItems = this.extractGeneratedItems(state);
    let recoveredAny = false;
    for (const item of generatedItems) {
      const callId = callIdOf(item);
      if (!callId) {
        continue;
      }
      this.toolLedger.recordFunctionResult(item);
      recoveredAny = true;
    }

    if (!recoveredAny) {
      return;
    }

    const reconciled = reconcileHistoryWithToolLedger(this.conversationStore.getHistory(), this.toolLedger.export());
    if (reconciled.addedCompletedPairs > 0) {
      this.conversationStore.replaceHistory(reconciled.history as AgentInputItem[]);
    }
  }

  /**
   * Prune the tool ledger to only include entries from the current history.
   */
  pruneToCurrentHistory(): void {
    const userTurnCount = this.conversationStore.listUserTurns().length;
    const historyCallIds = new Set(
      this.conversationStore
        .getHistory()
        .map((item) => callIdOf(item))
        .filter(Boolean),
    );
    const filteredEntries = this.toolLedger.export().filter((entry) => {
      const match = /^turn-(\d+)$/.exec(entry.turnId);
      if (match) {
        return Number.parseInt(match[1], 10) <= userTurnCount;
      }

      return historyCallIds.has(entry.callId);
    });

    this.toolLedger.import(filteredEntries);
  }

  /**
   * Deduplicate tool_started events.
   */
  dedupeToolStarted(event: ConversationEvent): ConversationEvent | null {
    if (event.type === 'subagent_tool_started') {
      const key = `${event.agentId}:${event.toolCallId}`;
      if (this.emittedSubagentToolStartedIds.has(key)) {
        return null;
      }
      this.emittedSubagentToolStartedIds.add(key);
      return event;
    }
    if (event.type !== 'tool_started') {
      return event;
    }
    if (this.emittedToolStartedCallIds.has(event.toolCallId)) {
      return null;
    }
    this.emittedToolStartedCallIds.add(event.toolCallId);
    return event;
  }

  /**
   * Reconcile history with the tool ledger and return the reconciled history.
   */
  getReconciledHistory(): AgentInputItem[] {
    return reconcileHistoryWithToolLedger(this.conversationStore.getHistory(), this.toolLedger.export())
      .history as AgentInputItem[];
  }

  /**
   * Reconcile history with the tool ledger and update the store if needed.
   * Returns true if any changes were made.
   */
  reconcileAndUpdateHistory(): boolean {
    const reconciled = reconcileHistoryWithToolLedger(this.conversationStore.getHistory(), this.toolLedger.export());
    if (reconciled.addedCompletedPairs > 0 || reconciled.droppedIncompleteCalls > 0) {
      this.conversationStore.replaceHistory(reconciled.history as AgentInputItem[]);
      return true;
    }
    return false;
  }

  /**
   * Clear tool-call arguments cache.
   */
  clearArguments(): void {
    this.toolCallArgumentsById.clear();
  }

  /**
   * Restore tool-call arguments from a saved map.
   */
  restoreArguments(savedArgs: Map<string, unknown>): void {
    this.toolCallArgumentsById.clear();
    if (savedArgs?.size) {
      for (const [key, value] of savedArgs.entries()) {
        this.toolCallArgumentsById.set(key, value);
      }
    }
  }

  /**
   * Clear emitted tool started call IDs.
   */
  clearEmittedToolStarted(): void {
    this.emittedToolStartedCallIds.clear();
  }

  /**
   * Reset the tracker to a fresh state (for session reset).
   */
  reset(): void {
    this.toolLedger = new ToolExecutionLedger();
  }

  private extractGeneratedItems(state: unknown): unknown[] {
    const record = state && typeof state === 'object' ? (state as { _generatedItems?: unknown }) : null;
    const items = record?._generatedItems;
    return Array.isArray(items) ? items : [];
  }
}
