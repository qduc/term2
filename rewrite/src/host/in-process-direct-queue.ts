/** Per-connection delivery only. It never acknowledges execution or backpressures Session. */
import type { WireEvent } from '../protocol/wire.js';

type Waiting = { resolve(value: IteratorResult<WireEvent>): void; reject(error: Error): void };
export class DirectEventQueue implements AsyncIterable<WireEvent> {
  readonly #events: WireEvent[] = [];
  readonly #waiting: Waiting[] = [];
  #closed = false;
  #error: Error | null = null;
  #consumed = false;
  onClose: (() => void) | undefined;
  constructor(readonly detach: () => void) {}
  get closed(): boolean {
    return this.#closed;
  }
  push(event: WireEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.#events.push(event);
  }
  /** Disconnect discards only this connection's unread presentation, never Session work. */
  close(): void {
    this.#events.length = 0;
    this.#end(null);
  }
  /** Already queued accepted events remain readable before the transport failure surfaces. */
  fail(error: Error): void {
    this.#end(error);
  }
  #end(error: Error | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    this.detach();
    this.onClose?.();
    for (const waiter of this.#waiting.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }
  #next(): Promise<IteratorResult<WireEvent>> {
    const event = this.#events.shift();
    if (event) return Promise.resolve({ done: false, value: event });
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  }
  [Symbol.asyncIterator](): AsyncIterator<WireEvent> {
    if (this.#consumed) throw new Error('A connection event stream has one consumer');
    this.#consumed = true;
    return {
      next: () => this.#next(),
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
      throw: async (error) => {
        this.close();
        throw error;
      },
    };
  }
}
