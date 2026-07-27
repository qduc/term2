export type PostExecuteDecision = 'approve' | 'reject';

export type PostExecutePendingEntry = {
  /** Stable across UI re-renders; includes the session epoch and live run identity. */
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  argumentsText: string;
};

export type PostExecutePendingSnapshot = {
  sessionId: string;
  epoch: string | number;
  /** Monotonic snapshot revision. Notifications are only a hint to re-read this. */
  revision: number;
  entries: readonly PostExecutePendingEntry[];
  closed: boolean;
};

export type PostExecuteDecisionRequest = {
  revision: number;
  ids: readonly string[];
  decision: PostExecuteDecision;
};

export type PostExecuteDecisionResult =
  | { kind: 'settled'; settledIds: readonly string[] }
  | { kind: 'invalid'; reason: 'closed' | 'revision_mismatch' | 'empty_selection' | 'duplicate_id' | 'unknown_entry' };

type Pending = {
  entry: PostExecutePendingEntry;
  settle: (decision: PostExecuteDecision) => void;
};

/**
 * Session/epoch-owned post-execute gates.
 *
 * This deliberately has no notion of an SDK dispatch barrier: each snapshot is
 * authoritative only for registrations visible at its revision. Callers must
 * re-read after every wakeup. Decisions validate the complete selected set
 * before settling any gate, so a stale or partial request cannot half-apply.
 */
export class PostExecutePendingRegistry {
  readonly #sessionId: string;
  readonly #epoch: string | number;
  readonly #pending = new Map<string, Pending>();
  readonly #waiters = new Set<(version: number) => void>();
  #revision = 0;
  #closed = false;

  constructor(options: { sessionId: string; epoch: string | number }) {
    this.#sessionId = options.sessionId;
    this.#epoch = options.epoch;
  }

  get version(): number {
    return this.#revision;
  }

  snapshot(): PostExecutePendingSnapshot {
    return {
      sessionId: this.#sessionId,
      epoch: this.#epoch,
      revision: this.#revision,
      entries: [...this.#pending.values()].map(({ entry }) => ({ ...entry })),
      closed: this.#closed,
    };
  }

  entriesForRun(runId: string): readonly PostExecutePendingEntry[] {
    return this.snapshot().entries.filter((entry) => entry.runId === runId);
  }

  /** Resolves after a later state change, or immediately if one was already observed. */
  waitForChange(observedVersion: number): Promise<number> {
    if (this.#revision !== observedVersion) return Promise.resolve(this.#revision);
    return new Promise((resolve) => this.#waiters.add(resolve));
  }

  /** Cancellable subscription for consumers that race registry and local events. */
  watchForChange(observedVersion: number): { promise: Promise<number>; unsubscribe: () => void } {
    if (this.#revision !== observedVersion) {
      return { promise: Promise.resolve(this.#revision), unsubscribe: () => {} };
    }
    let active = true;
    let resolveWaiter!: (version: number) => void;
    const promise = new Promise<number>((resolve) => {
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

  register(input: Omit<PostExecutePendingEntry, 'id'>): Promise<PostExecuteDecision> {
    if (this.#closed) throw new Error('Post-execute pending registry is closed');
    const id = `${this.#sessionId}:${this.#epoch}:${input.runId}:${input.toolCallId}`;
    if (this.#pending.has(id)) throw new Error(`Duplicate active post-execute gate: ${id}`);

    return new Promise<PostExecuteDecision>((settle) => {
      this.#pending.set(id, { entry: { ...input, id }, settle });
      this.#changed();
    });
  }

  decide(request: PostExecuteDecisionRequest): PostExecuteDecisionResult {
    if (this.#closed) return { kind: 'invalid', reason: 'closed' };
    if (request.revision !== this.#revision) return { kind: 'invalid', reason: 'revision_mismatch' };
    if (request.ids.length === 0) return { kind: 'invalid', reason: 'empty_selection' };
    const ids = [...request.ids];
    if (new Set(ids).size !== ids.length) return { kind: 'invalid', reason: 'duplicate_id' };
    if (ids.some((id) => !this.#pending.has(id))) return { kind: 'invalid', reason: 'unknown_entry' };

    const selected = ids.map((id) => this.#pending.get(id)!);
    for (const id of ids) this.#pending.delete(id);
    this.#changed();
    for (const pending of selected) pending.settle(request.decision);
    return { kind: 'settled', settledIds: ids };
  }

  /** Fail closed: unblock every held tool before the session can be replaced. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#changed();
    for (const gate of pending) gate.settle('reject');
  }

  /** Fail closed for one terminal live run without closing its replacement session. */
  closeRun(runId: string): void {
    const pending = [...this.#pending.entries()].filter(([, gate]) => gate.entry.runId === runId);
    if (pending.length === 0) return;
    for (const [id] of pending) this.#pending.delete(id);
    this.#changed();
    for (const [, gate] of pending) gate.settle('reject');
  }

  #changed(): void {
    this.#revision += 1;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake(this.#revision);
  }
}
