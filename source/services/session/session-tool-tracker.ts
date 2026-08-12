import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { ToolExecutionLedger, type SavedToolExecution, callIdOf } from '../tool-execution-ledger.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import { projectProviderHistory } from '../conversation/conversation-state-projector.js';

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

  /** Returns only completed tool-result call IDs recorded during the current turn. */
  completedResultCallIdsForCurrentTurn(): string[] {
    return this.toolLedger.completedResultCallIdsForCurrentTurn();
  }

  /**
   * Call ids recorded this turn that still lack a completed tool result.
   * Aborted/unknown/started entries count — local synthetic results do not pay
   * provider-side tool debt while previousResponseId still points at the chain.
   */
  unsettledToolCallIdsForCurrentTurn(): string[] {
    const completed = new Set(this.completedResultCallIdsForCurrentTurn());
    return this.activeCallIdsForCurrentTurn().filter((callId) => !completed.has(callId));
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
   * Mark that tool execution has begun for this callId (side effects may occur).
   */
  markDispatched(callId: string): void {
    this.toolLedger.markDispatched(callId);
  }

  /**
   * Mark open calls as aborted with the given error message.
   */
  markOpenCallsAborted(errorMessage: string, callId?: string): void {
    this.toolLedger.markOpenCallsAborted(errorMessage, callId);
  }

  /**
   * Settle open calls after stream failure: dispatched → unknown, otherwise aborted.
   */
  settleOpenCallsOnStreamFailure(
    reason = 'Stream failed',
    callId?: string,
  ): {
    abortedCallIds: string[];
    unknownCallIds: string[];
  } {
    return this.toolLedger.settleOpenCallsOnStreamFailure(reason, callId);
  }

  /**
   * Get a recovery summary if there are recovered/dropped calls.
   */
  getRecoverySummary(): { recoveredCallIds: string[]; droppedCallIds: string[]; message: string } | null {
    return this.toolLedger.getRecoverySummary();
  }

  /**
   * Restore completed, aborted, and unknown tool ledger entries from a snapshot.
   *
   * Completed entries carry their results forward so they can be reprojected
   * into history. Aborted and unknown entries (with synthetic results) are also
   * preserved so the reconciler injects result pairs for interrupted tool calls
   * instead of leaving dangling function_call items.
   */
  restoreCompletedEntries(snapshot: SavedToolExecution[]): void {
    const merged = [...snapshot];
    const indexByCallId = new Map<string, number>();

    merged.forEach((entry, index) => {
      indexByCallId.set(entry.callId, index);
    });

    for (const entry of this.toolLedger.export()) {
      if (entry.status !== 'completed' && entry.status !== 'aborted' && entry.status !== 'unknown') {
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
  getReconciledHistory(): ProviderInputItem[] {
    return projectProviderHistory({
      history: this.conversationStore.getHistory(),
      toolLedger: this.toolLedger.export(),
    }).history;
  }

  /**
   * Reconcile history with the tool ledger and update the store if needed.
   * Returns true if any changes were made.
   */
  reconcileAndUpdateHistory(): boolean {
    const projected = projectProviderHistory({
      history: this.conversationStore.getHistory(),
      toolLedger: this.toolLedger.export(),
    });
    if (projected.warnings.length > 0) {
      this.conversationStore.replaceHistory(projected.history);
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
}
