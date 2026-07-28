import type {
  AssistantJournalDeltaLogEvent,
  AssistantJournalItemLogEvent,
  LogEvent,
} from './conversation-log-events.js';
import type { PersistedAssistantTurnItem } from '../conversation/conversation-persistence-types.js';
import { buildPersistedAssistantItemsFromRaw } from '../conversation/conversation-turn-items.js';

export interface AssistantTurnJournalOptions {
  /** Resolves the active turn id; usually backed by the tool ledger. */
  getCurrentTurnId: () => string;
  /** Sink that accepts the resulting log events. May be set later via setSink. */
  sink?: (event: LogEvent) => void;
}

/**
 * Owns the turn-scoped assistant-output journal: a streaming, append-only
 * sequence of events that captures assistant text, reasoning, and provider-
 * backed run items as early as they become available, so a process crash
 * between streaming and `final` can be reconstructed on resume.
 *
 * The journal never opens files or fsyncs itself; it emits standard log
 * events that flow through the existing `ConversationLogWriter`. The writer
 * decides which events are critical (and therefore fsync'd).
 *
 * Sequence numbers are monotonic per turn and reset when `resetForNewTurn`
 * is called. The current turn id is read on each call so approval
 * continuations stay on the same logical turn.
 *
 * Item events are buffered in memory so they can serve as the source of truth
 * for live turn recovery as well as crash recovery.
 */
export class AssistantTurnJournal {
  #getCurrentTurnId: () => string;
  #sink: ((event: LogEvent) => void) | null;
  #seq = 0;
  #emittedItemKeys: Set<string> = new Set();
  #itemEvents: AssistantJournalItemLogEvent[] = [];

  constructor(opts: AssistantTurnJournalOptions) {
    this.#getCurrentTurnId = opts.getCurrentTurnId;
    this.#sink = opts.sink ?? null;
  }

  /**
   * Replaces the downstream sink and flushes any buffered item events.
   * Passing null stops emission; buffered events are retained until a sink
   * is set again. Idempotent: calling with the same sink is a no-op.
   */
  setSink(sink: ((event: LogEvent) => void) | null): void {
    if (this.#sink === sink) {
      return;
    }
    this.#sink = sink;
    if (sink) {
      for (const event of this.#itemEvents) {
        this.#emit(event);
      }
    }
  }

  /**
   * Resets the per-turn sequence counter and dedup set so the next turn's
   * journal entries start fresh. Call when a new user turn is submitted.
   */
  resetForNewTurn(): void {
    this.#seq = 0;
    this.#emittedItemKeys.clear();
  }

  /**
   * Returns all durable item events emitted so far, across all turns.
   */
  getEvents(): AssistantJournalItemLogEvent[] {
    return [...this.#itemEvents];
  }

  /**
   * Returns all durable persisted items emitted so far, across all turns.
   */
  getItems(): PersistedAssistantTurnItem[] {
    return this.#itemEvents.map((event) => event.item);
  }

  /**
   * Returns durable item events for the current turn only.
   */
  getCurrentTurnEvents(): AssistantJournalItemLogEvent[] {
    const turnId = this.#getCurrentTurnId();
    return this.#itemEvents.filter((event) => event.turnId === turnId);
  }

  /**
   * Returns durable persisted items for the current turn only.
   */
  getCurrentTurnItems(): PersistedAssistantTurnItem[] {
    return this.getCurrentTurnEvents().map((event) => event.item);
  }

  /**
   * Append a streaming text delta as a journal fragment. These events are
   * non-critical and not fsync'd; the final `assistant_turn` and any
   * provider-backed journal items are the durable record.
   */
  recordTextDelta(delta: string): void {
    if (!delta) {
      return;
    }
    this.#emitDelta('text', delta);
  }

  /**
   * Append a streaming reasoning delta as a journal fragment.
   */
  recordReasoningDelta(delta: string): void {
    if (!delta) {
      return;
    }
    this.#emitDelta('reasoning', delta);
  }

  /**
   * Record a provider-backed run item (function call, tool result,
   * assistant message, or reasoning). Duplicates within the same turn are
   * suppressed by the normalized item's call or provider identity.
   *
   * Returns the normalized persisted item so callers can layer additional
   * recovery logic on top.
   */
  recordRunItem(item: unknown): PersistedAssistantTurnItem[] {
    if (item == null) {
      return [];
    }
    const items = buildPersistedAssistantItemsFromRaw(item);
    if (items.length === 0) {
      return [];
    }

    const dedupKey = makeItemDedupKey(items);
    if (dedupKey && this.#emittedItemKeys.has(dedupKey)) {
      return [];
    }
    if (dedupKey) {
      this.#emittedItemKeys.add(dedupKey);
    }

    for (const persisted of items) {
      const event: AssistantJournalItemLogEvent = {
        type: 'assistant_journal_item',
        turnId: this.#getCurrentTurnId(),
        seq: ++this.#seq,
        item: persisted,
      };
      this.#itemEvents.push(event);
      this.#emit(event);
    }
    return items;
  }

  /**
   * Returns the next sequence number without emitting an event. Useful for
   * tests and for callers that need to reason about the journal ordering.
   */
  peekNextSeq(): number {
    return this.#seq + 1;
  }

  #emit(event: LogEvent): void {
    this.#sink?.(event);
  }

  #emitDelta(kind: 'text' | 'reasoning', delta: string): void {
    const event: AssistantJournalDeltaLogEvent = {
      type: 'assistant_journal_delta',
      turnId: this.#getCurrentTurnId(),
      seq: ++this.#seq,
      kind,
      delta,
    };
    this.#emit(event);
  }
}

/**
 * Compute one stable identity for a normalized run item group. Tool identity
 * wins so a provider wrapper and its equivalent canonical tool item share a
 * key. The group is suppressed as a whole to avoid partially replaying items
 * produced by one provider record.
 */
function makeItemDedupKey(items: readonly PersistedAssistantTurnItem[]): string | null {
  for (const item of items) {
    if (item.type === 'tool_call' || item.type === 'tool_result') {
      return `${item.type}:${item.callId}`;
    }
  }

  for (const item of items) {
    if ((item.type === 'reasoning' || item.type === 'assistant_text') && item.providerItemId) {
      return `${item.type}:${item.providerItemId}`;
    }
  }

  return null;
}
