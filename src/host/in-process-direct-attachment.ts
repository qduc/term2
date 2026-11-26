/** One atomic Session attachment and one projection, shared by all host connections. */
import type { DirectSession, DirectSessionUpdate } from '../session/facade-types.js';
import { DirectProjection } from '../protocol/projection.js';
import { DirectProtocolError } from '../protocol/errors.js';
import { DirectEventQueue, directBatch } from './in-process-direct-queue.js';

export class DirectAttachment {
  readonly session: DirectSession;
  readonly #queues = new Set<DirectEventQueue>();
  readonly #unsubscribe: () => void;
  readonly #projection: DirectProjection;
  #position: number;
  /** Publications applied to the projection so far; a batch carries the ordinal it was published at. */
  #ordinal = 0;
  #failure: Error | null = null;
  #closed = false;

  constructor(session: DirectSession) {
    this.session = session;
    // Capture can enqueue callbacks while constructing. Never lose the atomic-cut tail.
    const pending: DirectSessionUpdate[] = [];
    let ready = false;
    const capture = session.captureFrom(0, (update) => {
      if (ready) this.#update(update);
      else pending.push(update);
    });
    this.#unsubscribe = () => capture.unsubscribe();
    this.#position = capture.position;
    try {
      if (capture.state.id !== session.id) throw new Error('Captured state belongs to another session');
      // Current arrays alone cannot recover mixed chronology or final/draft correlation.
      // Reconstruct from the actual accepted prefix, then synchronize live-only state.
      this.#projection = DirectProjection.forReplay(capture.state);
      for (const entry of capture.replay) this.#projection.update(entry);
      this.#projection.synchronize(capture.state);
    } catch (error) {
      capture.unsubscribe();
      throw error;
    }
    ready = true;
    for (const update of pending) this.#update(update);
  }
  /** Snapshot and live subscription are taken synchronously at this public-state cut. */
  connect(): {
    readonly snapshot: DirectProjection['snapshot'];
    readonly events: DirectEventQueue;
    readonly cut: () => { readonly snapshot: DirectProjection['snapshot']; readonly ordinal: number };
  } {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new DirectProtocolError('closed', 'Session attachment is closed.');
    const events = new DirectEventQueue(() => this.#queues.delete(events));
    this.#queues.add(events);
    const projection = this.#projection;
    return {
      get snapshot() {
        return projection.snapshot;
      },
      events,
      // Read together, synchronously: the snapshot contains every batch published at or before the ordinal.
      cut: () => ({ snapshot: projection.snapshot, ordinal: this.#ordinal }),
    };
  }
  #update(update: DirectSessionUpdate): void {
    if (this.#closed || this.#failure) return;
    try {
      if (!Number.isSafeInteger(update.position) || update.position <= this.#position)
        throw new Error('Session publication position is not strictly increasing');
      this.#position = update.position;
      const batch = directBatch(update, this.#projection.update(update), ++this.#ordinal);
      for (const queue of this.#queues) queue.push(batch);
    } catch {
      // Presentation failures must not propagate into Session's durable acceptance path.
      this.#failure = new DirectProtocolError('internal_error', 'Session projection failed.');
      this.#unsubscribe();
      for (const queue of [...this.#queues]) queue.fail(this.#failure);
    }
  }
  /** Detaches presentation; the owning store remains responsible for Session cleanup. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    for (const queue of [...this.#queues]) queue.close();
  }
}
