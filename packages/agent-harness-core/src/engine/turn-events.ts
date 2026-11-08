/** A single-consumer channel: only the delivered event's receipt releases its producer. */
import type { AcceptedTurnEvent, TurnEvent, TurnResult } from './types.js';

type Receipt = {
  delivered: boolean;
  resolve(): void;
  reject(error: Error): void;
  accepted?: () => void;
};

// These outcomes are chosen only after an accepted compaction start; success
// additionally requires accepted history replacement. Cancellation must not
// erase that evidence or relabel accepted replacement as failed compaction.
const isCleanup = (event: TurnEvent): boolean =>
  event.type === 'compaction_completed' ||
  event.type === 'compaction_failed' ||
  event.type === 'tool_execution_finished' ||
  event.type === 'request_cost' ||
  (event.type === 'item' && event.item.type === 'tool_result');

export class TurnEvents {
  readonly #queue: AcceptedTurnEvent[] = [];
  readonly #receipts = new Map<number, Receipt>();
  #nextToken = 0;
  #wake: (() => void) | undefined;
  #cancelled = false;
  #ended = false;

  /** Resolves only after Session accepts this delivered token, never a sibling's. */
  publish(event: TurnEvent, accepted?: () => void): Promise<void> {
    if (this.#ended) return Promise.reject(cancelled());
    if (this.#cancelled) {
      if (!isCleanup(event)) return Promise.reject(cancelled());
      this.#enqueue(event);
      return Promise.resolve();
    }
    const token = ++this.#nextToken;
    const promise = new Promise<void>((resolve, reject) => {
      this.#receipts.set(token, { delivered: false, resolve, reject, accepted });
    });
    this.#queue.push({ token, event });
    this.#notify();
    return promise;
  }

  /** Accepting a queued, stale or duplicate token cannot authorize any operation. */
  accept(token: number): void {
    const receipt = this.#receipts.get(token);
    if (!receipt?.delivered) return;
    this.#receipts.delete(token);
    receipt.accepted?.();
    receipt.resolve();
  }

  /** Reject all waits, retaining only known physical outcomes for cleanup draining. */
  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    for (const receipt of this.#receipts.values()) receipt.reject(cancelled());
    this.#receipts.clear();
    const cleanup = this.#queue.filter(({ event }) => isCleanup(event) || event.type === 'turn_ended');
    this.#queue.splice(0, this.#queue.length, ...cleanup);
    this.#notify();
  }

  /** Terminal delivery does not depend on another acknowledgement/consumer iteration. */
  finish(result: TurnResult): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#enqueue({ type: 'turn_ended', result });
  }

  async *events(): AsyncGenerator<AcceptedTurnEvent> {
    while (true) {
      const next = this.#queue.shift();
      if (!next) {
        if (this.#ended) return;
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        continue;
      }
      const receipt = this.#receipts.get(next.token);
      if (receipt) receipt.delivered = true;
      yield next;
      if (next.event.type === 'turn_ended') return;
    }
  }

  #enqueue(event: TurnEvent): void {
    this.#queue.push({ token: ++this.#nextToken, event });
    this.#notify();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

export function cancelled(): Error {
  return new Error('Turn cancelled');
}
