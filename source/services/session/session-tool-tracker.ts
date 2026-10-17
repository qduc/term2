import type { ConversationEvent } from '../conversation/conversation-events.js';

/** Presentation caches only; accepted tool evidence belongs to ConversationRecord. */
export class SessionToolTracker {
  private toolCallArgumentsById = new Map<string, unknown>();
  private emittedInvalidToolCallPackets = new Set<string>();
  private emittedToolStartedCallIds = new Set<string>();
  private emittedSubagentToolStartedIds = new Set<string>();
  private emittedCommandMessageIdsByCallId = new Map<string, string[]>();

  get argumentsById(): Map<string, unknown> {
    return this.toolCallArgumentsById;
  }
  get invalidPackets(): Set<string> {
    return this.emittedInvalidToolCallPackets;
  }

  /** A settled result allows a later provider reuse of the call id to render anew. */
  noteResultObserved(callId: string): void {
    this.emittedToolStartedCallIds.delete(callId);
  }

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
   * Remember which command message ids a call emitted. Message ids come from the tool's formatter
   * (`<provider item id or call id>-<n>`), so they cannot be derived from the call id later.
   */
  noteCommandMessageEmitted(message: { id: string; callId?: string }): void {
    if (!message.callId) return;
    const ids = this.emittedCommandMessageIdsByCallId.get(message.callId) ?? [];
    ids.push(message.id);
    this.emittedCommandMessageIdsByCallId.set(message.callId, ids);
  }

  /**
   * Command message ids emitted by an earlier execution of this call id, which a new execution that
   * reuses the id must not be deduped against. Forgets them.
   */
  takeCommandMessageIdsOfEarlierExecution(callId: string): string[] {
    const ids = this.emittedCommandMessageIdsByCallId.get(callId) ?? [];
    this.emittedCommandMessageIdsByCallId.delete(callId);
    return ids;
  }

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
    this.emittedCommandMessageIdsByCallId.clear();
  }
}
