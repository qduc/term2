/**
 * Stable identity for one approval pause in an adopted subagent run.
 *
 * A generation is necessary because one live run can pause again after its
 * earlier continuation resumes. Tool name and arguments are included in the
 * identity checked against UI requests, so a delayed action cannot approve a
 * different tool call that happens to share a call id.
 */
export type BackgroundSubagentApprovalMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly BackgroundSubagentApprovalMetadataValue[]
  | { readonly [key: string]: BackgroundSubagentApprovalMetadataValue };

export type BackgroundSubagentApprovalEntry = {
  readonly runId: string;
  readonly generation: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsText: string;
  /** Presentation or policy data retained without interpretation by this queue. */
  readonly metadata?: Readonly<Record<string, BackgroundSubagentApprovalMetadataValue>>;
};

/** Raw UI input; approval policy and lease resumption interpret it elsewhere. */
export type BackgroundSubagentApprovalDecision = {
  readonly answer: string;
  readonly rejectionReason?: string;
  readonly approvalAnswer?: string;
};

export type BackgroundSubagentApprovalSnapshot = {
  /** Monotonic. A notification is only a hint to read this authoritative state. */
  readonly revision: number;
  /** Only this FIFO head may be resolved. Later entries intentionally stay hidden. */
  readonly current: BackgroundSubagentApprovalEntry | null;
  readonly pendingCount: number;
  readonly closed: boolean;
};

export type BackgroundSubagentApprovalResolutionRequest = {
  readonly revision: number;
  readonly entry: BackgroundSubagentApprovalEntry;
  readonly decision: BackgroundSubagentApprovalDecision;
};

export type BackgroundSubagentApprovalUpdateRequest = {
  readonly revision: number;
  readonly expected: BackgroundSubagentApprovalEntry;
  readonly entry: BackgroundSubagentApprovalEntry;
};

export type BackgroundSubagentApprovalRemovalRequest = {
  readonly revision: number;
  readonly entry: BackgroundSubagentApprovalEntry;
};

export type BackgroundSubagentApprovalRelease = { readonly kind: 'removed' | 'closed' };

export type BackgroundSubagentApprovalCallbacks = {
  /** Applies the raw answer while this entry still owns the visible head. */
  readonly onResolve: (entry: BackgroundSubagentApprovalEntry, decision: BackgroundSubagentApprovalDecision) => void;
  /**
   * The run owner is told that this queue no longer owns its pause. It decides
   * how to release the lease; this primitive never manufactures a rejection.
   */
  readonly onRelease?: (entry: BackgroundSubagentApprovalEntry, release: BackgroundSubagentApprovalRelease) => void;
};

export type BackgroundSubagentApprovalEnqueueResult =
  | { readonly kind: 'enqueued'; readonly revision: number }
  | { readonly kind: 'closed' };

export type BackgroundSubagentApprovalResolveResult =
  | {
      readonly kind: 'resolved';
      readonly entry: BackgroundSubagentApprovalEntry;
      readonly decision: BackgroundSubagentApprovalDecision;
    }
  | { readonly kind: 'stale'; readonly reason: 'revision_mismatch' | 'identity_mismatch' }
  | { readonly kind: 'closed' };

export type BackgroundSubagentApprovalUpdateResult =
  | { readonly kind: 'updated'; readonly revision: number }
  | { readonly kind: 'stale'; readonly reason: 'revision_mismatch' | 'identity_mismatch' }
  | { readonly kind: 'closed' };

export type BackgroundSubagentApprovalRemoveResult =
  | { readonly kind: 'removed'; readonly revision: number; readonly releaseErrors?: readonly unknown[] }
  | { readonly kind: 'stale'; readonly reason: 'revision_mismatch' | 'identity_mismatch' }
  | { readonly kind: 'closed' };

type Pending = {
  entry: BackgroundSubagentApprovalEntry;
  callbacks: BackgroundSubagentApprovalCallbacks;
};

type Listener = () => void;

function sameIdentity(left: BackgroundSubagentApprovalEntry, right: BackgroundSubagentApprovalEntry): boolean {
  return (
    left.runId === right.runId &&
    left.generation === right.generation &&
    left.toolCallId === right.toolCallId &&
    left.toolName === right.toolName &&
    left.argumentsText === right.argumentsText
  );
}

function cloneAndFreezeMetadataValue(
  value: BackgroundSubagentApprovalMetadataValue,
  ancestors: Set<object>,
): BackgroundSubagentApprovalMetadataValue {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new TypeError('Background subagent approval metadata must not contain cycles.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => cloneAndFreezeMetadataValue(item, ancestors)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Background subagent approval metadata must contain only plain data.');
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, cloneAndFreezeMetadataValue(item, ancestors)]),
      ),
    );
  } finally {
    ancestors.delete(value);
  }
}

function freezeEntry(entry: BackgroundSubagentApprovalEntry): BackgroundSubagentApprovalEntry {
  const metadata = entry.metadata
    ? (cloneAndFreezeMetadataValue(entry.metadata, new Set()) as Readonly<
        Record<string, BackgroundSubagentApprovalMetadataValue>
      >)
    : undefined;
  return Object.freeze({ ...entry, ...(metadata ? { metadata } : {}) });
}

function freezeSnapshot(
  revision: number,
  pending: readonly Pending[],
  closed: boolean,
): BackgroundSubagentApprovalSnapshot {
  return Object.freeze({
    revision,
    current: pending[0]?.entry ?? null,
    pendingCount: pending.length,
    closed,
  });
}

/**
 * Session-owned FIFO arbitration for approvals emitted by adopted subagent
 * leases. It owns ordering, immutable external-store snapshots, and stale
 * action rejection. It deliberately does not know approval policy, Ink, or a
 * child continuation: callers take a successful claim to the lease that owns
 * resumption.
 */
export class BackgroundSubagentApprovalQueue {
  #pending: Pending[] = [];
  /** Last revision each listener was notified about. */
  #listeners = new Map<Listener, number>();
  #revision = 0;
  #closed = false;
  #snapshot: BackgroundSubagentApprovalSnapshot = freezeSnapshot(0, [], false);
  #notifying = false;
  #resolving: Pending | undefined;

  getSnapshot(): BackgroundSubagentApprovalSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    // A subscription begins after the consumer has read the current snapshot.
    // Using the current revision also prevents unsubscribe/resubscribe inside a
    // notification from resetting progress and spinning the dispatch loop.
    this.#listeners.set(listener, this.#revision);
    return () => this.#listeners.delete(listener);
  }

  enqueue(
    entry: BackgroundSubagentApprovalEntry,
    callbacks: BackgroundSubagentApprovalCallbacks,
  ): BackgroundSubagentApprovalEnqueueResult {
    if (this.#closed) return { kind: 'closed' };
    const immutableEntry = freezeEntry(entry);
    if (this.#pending.some((pending) => sameIdentity(pending.entry, immutableEntry))) {
      throw new Error(
        `Duplicate background subagent approval: ${immutableEntry.runId}:${immutableEntry.generation}:${immutableEntry.toolCallId}`,
      );
    }
    this.#pending.push({
      entry: immutableEntry,
      callbacks: { onResolve: callbacks.onResolve, ...(callbacks.onRelease ? { onRelease: callbacks.onRelease } : {}) },
    });
    this.#changed();
    return { kind: 'enqueued', revision: this.#revision };
  }

  /**
   * Resolves exactly the visible FIFO head. Its callback applies the raw
   * decision while the head and snapshot remain authoritative. Only a
   * successful application promotes and publishes the next entry.
   */
  resolve(request: BackgroundSubagentApprovalResolutionRequest): BackgroundSubagentApprovalResolveResult {
    if (this.#closed) return { kind: 'closed' };
    if (request.revision !== this.#revision) return { kind: 'stale', reason: 'revision_mismatch' };
    const current = this.#pending[0];
    if (!current || !sameIdentity(current.entry, request.entry)) return { kind: 'stale', reason: 'identity_mismatch' };
    if (current === this.#resolving) return { kind: 'stale', reason: 'identity_mismatch' };

    const decision = Object.freeze({ ...request.decision });
    this.#resolving = current;
    try {
      current.callbacks.onResolve(current.entry, decision);
    } finally {
      this.#resolving = undefined;
    }
    this.#pending.shift();
    this.#changed();
    return { kind: 'resolved', entry: current.entry, decision };
  }

  /**
   * Replaces opaque presentation metadata for one still-pending pause. The
   * execution identity may not change; a replacement is not a transfer.
   */
  update(request: BackgroundSubagentApprovalUpdateRequest): BackgroundSubagentApprovalUpdateResult {
    if (this.#closed) return { kind: 'closed' };
    if (request.revision !== this.#revision) return { kind: 'stale', reason: 'revision_mismatch' };
    if (!sameIdentity(request.expected, request.entry)) return { kind: 'stale', reason: 'identity_mismatch' };
    const index = this.#pending.findIndex((pending) => sameIdentity(pending.entry, request.expected));
    if (index < 0) return { kind: 'stale', reason: 'identity_mismatch' };
    if (this.#pending[index] === this.#resolving) return { kind: 'stale', reason: 'identity_mismatch' };

    this.#pending[index] = { entry: freezeEntry(request.entry), callbacks: this.#pending[index]!.callbacks };
    this.#changed();
    return { kind: 'updated', revision: this.#revision };
  }

  /** Removes an exact pause after its owning run settles or is cancelled. */
  remove(request: BackgroundSubagentApprovalRemovalRequest): BackgroundSubagentApprovalRemoveResult {
    if (this.#closed) return { kind: 'closed' };
    if (request.revision !== this.#revision) return { kind: 'stale', reason: 'revision_mismatch' };
    const index = this.#pending.findIndex((pending) => sameIdentity(pending.entry, request.entry));
    if (index < 0) return { kind: 'stale', reason: 'identity_mismatch' };
    if (this.#pending[index] === this.#resolving) return { kind: 'stale', reason: 'identity_mismatch' };

    const [removed] = this.#pending.splice(index, 1);
    this.#changed();
    const releaseErrors = this.#release([removed!], { kind: 'removed' });
    return {
      kind: 'removed',
      revision: this.#revision,
      ...(releaseErrors.length > 0 ? { releaseErrors } : {}),
    };
  }

  /**
   * Terminal and idempotent. Closing never interprets an answer: each run
   * owner gets an explicit release callback and can cancel its own lease.
   */
  close(): readonly unknown[] {
    if (this.#closed) return Object.freeze([]);
    this.#closed = true;
    const pending = this.#pending;
    this.#pending = [];
    this.#changed();
    return this.#release(pending, { kind: 'closed' });
  }

  #release(pending: readonly Pending[], release: BackgroundSubagentApprovalRelease): readonly unknown[] {
    const errors: unknown[] = [];
    for (const item of pending) {
      try {
        item.callbacks.onRelease?.(item.entry, release);
      } catch (error) {
        errors.push(error);
      }
    }
    return Object.freeze(errors);
  }

  #changed(): void {
    this.#revision += 1;
    this.#snapshot = freezeSnapshot(this.#revision, this.#pending, this.#closed);
    if (this.#notifying) return;

    this.#notifying = true;
    try {
      while ([...this.#listeners.values()].some((revision) => revision < this.#revision)) {
        for (const listener of [...this.#listeners.keys()]) {
          if (this.#listeners.get(listener) === undefined || this.#listeners.get(listener)! >= this.#revision) continue;
          // Mark before invoking so reentrant changes cannot notify this
          // listener twice for the same externally visible revision.
          this.#listeners.set(listener, this.#revision);
          listener();
        }
      }
    } finally {
      this.#notifying = false;
    }
  }
}
