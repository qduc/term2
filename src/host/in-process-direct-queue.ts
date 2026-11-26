/** Per-connection delivery only. It never acknowledges execution or backpressures Session. */
import type { DirectSessionUpdate } from '../session/facade-types.js';
import type { WireEvent } from '../protocol/wire.js';

/**
 * Everything one Session publication projected to, in order: one accepted fact (possibly no events at all, when
 * the fact is not shown), one live transient, or one state synchronization ending in a snapshot. The
 * direct-wire-v2 stream sends one frame per batch; event consumers see the events one by one.
 */
export type WireEventBatch = {
  readonly kind: 'accepted' | 'live' | 'snapshot';
  /** The accepted seq for `accepted`, the snapshot's cut for `snapshot`, null for `live`. */
  readonly seq: number | null;
  readonly occurredAt: string | null;
  readonly events: readonly WireEvent[];
  /** Which attachment publication this is; a snapshot cut read at ordinal N already contains batches up to N. */
  readonly ordinal: number;
};

/** The batch one Session update produced, with the boundary the update itself carries. */
export function directBatch(
  update: DirectSessionUpdate,
  events: readonly WireEvent[],
  ordinal: number,
): WireEventBatch {
  if (update.type === 'fact')
    return { kind: 'accepted', seq: update.seq, occurredAt: update.at ?? null, events, ordinal };
  if (update.type === 'transient') return { kind: 'live', seq: null, occurredAt: null, events, ordinal };
  const snapshot = events.at(-1);
  if (snapshot?.type !== 'snapshot') throw new Error('A state synchronization did not end in a snapshot');
  return { kind: 'snapshot', seq: snapshot.payload.snapshot.seq, occurredAt: null, events, ordinal };
}

type Waiting = { resolve(value: IteratorResult<WireEventBatch>): void; reject(error: Error): void };
export class DirectEventQueue implements AsyncIterable<WireEvent> {
  readonly #batches: WireEventBatch[] = [];
  readonly #waiting: Waiting[] = [];
  #closed = false;
  #error: Error | null = null;
  #consumed = false;
  onClose: (() => void) | undefined;
  constructor(readonly detach: () => void) {}
  get closed(): boolean {
    return this.#closed;
  }
  push(batch: WireEventBatch): void {
    if (this.#closed) return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter.resolve({ done: false, value: batch });
    else this.#batches.push(batch);
  }
  /** Disconnect discards only this connection's unread presentation, never Session work. */
  close(): void {
    this.#batches.length = 0;
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
  #next(): Promise<IteratorResult<WireEventBatch>> {
    const batch = this.#batches.shift();
    if (batch) return Promise.resolve({ done: false, value: batch });
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  }
  #claim(): void {
    if (this.#consumed) throw new Error('A connection event stream has one consumer');
    this.#consumed = true;
  }
  #iterator<T>(next: () => Promise<IteratorResult<T>>): AsyncIterator<T> {
    return {
      next,
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
  /** One batch per Session publication. The stream has one consumer: this or the event iterator. */
  batches(): AsyncIterable<WireEventBatch> {
    return { [Symbol.asyncIterator]: () => (this.#claim(), this.#iterator(() => this.#next())) };
  }
  [Symbol.asyncIterator](): AsyncIterator<WireEvent> {
    this.#claim();
    let current: readonly WireEvent[] = [];
    let index = 0;
    const next = async (): Promise<IteratorResult<WireEvent>> => {
      while (index >= current.length) {
        const result = await this.#next();
        if (result.done) return result;
        current = result.value.events;
        index = 0;
      }
      return { done: false, value: current[index++]! };
    };
    return this.#iterator(next);
  }
}
