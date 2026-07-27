import type { PostExecutePendingRegistry } from './post-execute-pending-registry.js';

export type LiveRunState<Event, Result> =
  | { kind: 'event'; event: Event }
  | {
      kind: 'post_execute_approval_required';
      entries: readonly import('./post-execute-pending-registry.js').PostExecutePendingEntry[];
    }
  | { kind: 'completed'; result: Result }
  | { kind: 'cancelled' };

/**
 * One foreground stream's ownership boundary. The consumer is started exactly
 * once and remains alive while an application post-execute gate holds a tool
 * promise. Callers only observe buffered events, gates, or its terminal result.
 */
export class LiveRun<Event, Result> {
  readonly #events: Event[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #completion: Promise<Result>;
  #result: Result | undefined;
  #error: unknown;
  #finished = false;
  #cancelled = false;

  constructor(
    readonly runId: string,
    private readonly pending: PostExecutePendingRegistry,
    consume: (emit: (event: Event) => void) => Promise<Result>,
  ) {
    this.#completion = Promise.resolve()
      .then(() => consume((event) => this.#emit(event)))
      .then(
        (result) => {
          if (this.#cancelled) return result;
          this.#result = result;
          this.#finished = true;
          this.pending.closeRun(this.runId);
          this.#changed();
          return result;
        },
        (error: unknown) => {
          if (this.#cancelled) throw error;
          this.#error = error;
          this.#finished = true;
          this.pending.closeRun(this.runId);
          this.#changed();
          throw error;
        },
      );
    // `next()` reports the stored failure. Keep a background rejection from
    // becoming unhandled while the application is showing an approval prompt.
    void this.#completion.catch(() => undefined);
  }

  get completion(): Promise<Result> {
    return this.#completion;
  }

  async next(): Promise<LiveRunState<Event, Result>> {
    while (true) {
      const event = this.#events.shift();
      if (event !== undefined) return { kind: 'event', event };
      if (this.#cancelled) return { kind: 'cancelled' };
      if (this.#error !== undefined) throw this.#error;
      if (this.#finished) return { kind: 'completed', result: this.#result as Result };

      const entries = this.pending.entriesForRun(this.runId);
      if (entries.length > 0) return { kind: 'post_execute_approval_required', entries };
      if (this.pending.snapshot().closed) throw new Error('Post-execute live run closed');

      const observedVersion = this.pending.version;
      const localChange = this.#waitForChange();
      const pendingChange = this.pending.watchForChange(observedVersion);
      try {
        await Promise.race([localChange.promise, pendingChange.promise]);
      } finally {
        localChange.unsubscribe();
        pendingChange.unsubscribe();
      }
    }
  }

  #emit(event: Event): void {
    if (this.#cancelled) return;
    this.#events.push(event);
    this.#changed();
  }

  #waitForChange(): { promise: Promise<void>; unsubscribe: () => void } {
    let active = true;
    let resolveWaiter!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
      this.#waiters.add(resolveWaiter);
    });
    return {
      promise,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.#waiters.delete(resolveWaiter);
      },
    };
  }

  #changed(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  /** Stop projecting this run and fail-close every gate it owns. */
  cancel(): void {
    if (this.#cancelled || this.#finished) return;
    this.#cancelled = true;
    this.pending.closeRun(this.runId);
    this.#changed();
  }
}
