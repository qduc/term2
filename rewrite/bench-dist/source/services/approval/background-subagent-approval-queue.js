function sameIdentity(left, right) {
    return (left.runId === right.runId &&
        left.generation === right.generation &&
        left.toolCallId === right.toolCallId &&
        left.toolName === right.toolName &&
        left.argumentsText === right.argumentsText);
}
function cloneAndFreezeMetadataValue(value, ancestors) {
    if (value === null || typeof value !== 'object')
        return value;
    if (ancestors.has(value))
        throw new TypeError('Background subagent approval metadata must not contain cycles.');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return Object.freeze(value.map((item) => cloneAndFreezeMetadataValue(item, ancestors)));
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('Background subagent approval metadata must contain only plain data.');
        }
        return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreezeMetadataValue(item, ancestors)])));
    }
    finally {
        ancestors.delete(value);
    }
}
function freezeEntry(entry) {
    const metadata = entry.metadata
        ? cloneAndFreezeMetadataValue(entry.metadata, new Set())
        : undefined;
    return Object.freeze({ ...entry, ...(metadata ? { metadata } : {}) });
}
function freezeSnapshot(revision, pending, closed) {
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
    #pending = [];
    /** Last revision each listener was notified about. */
    #listeners = new Map();
    #revision = 0;
    #closed = false;
    #snapshot = freezeSnapshot(0, [], false);
    #notifying = false;
    #resolving;
    getSnapshot() {
        return this.#snapshot;
    }
    subscribe(listener) {
        // A subscription begins after the consumer has read the current snapshot.
        // Using the current revision also prevents unsubscribe/resubscribe inside a
        // notification from resetting progress and spinning the dispatch loop.
        this.#listeners.set(listener, this.#revision);
        return () => this.#listeners.delete(listener);
    }
    enqueue(entry, callbacks) {
        if (this.#closed)
            return { kind: 'closed' };
        const immutableEntry = freezeEntry(entry);
        if (this.#pending.some((pending) => sameIdentity(pending.entry, immutableEntry))) {
            throw new Error(`Duplicate background subagent approval: ${immutableEntry.runId}:${immutableEntry.generation}:${immutableEntry.toolCallId}`);
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
    resolve(request) {
        if (this.#closed)
            return { kind: 'closed' };
        if (request.revision !== this.#revision)
            return { kind: 'stale', reason: 'revision_mismatch' };
        const current = this.#pending[0];
        if (!current || !sameIdentity(current.entry, request.entry))
            return { kind: 'stale', reason: 'identity_mismatch' };
        if (current === this.#resolving)
            return { kind: 'stale', reason: 'identity_mismatch' };
        const decision = Object.freeze({ ...request.decision });
        this.#resolving = current;
        let application;
        try {
            application = current.callbacks.onResolve(current.entry, decision);
        }
        finally {
            this.#resolving = undefined;
        }
        if (application.kind !== 'applied')
            return { kind: 'apply_rejected', entry: current.entry };
        // A terminal event may release this run synchronously inside application.
        // Never consume the sibling promoted by that lifecycle cleanup.
        if (this.#pending[0] === current) {
            this.#pending.shift();
            this.#changed();
        }
        return { kind: 'resolved', entry: current.entry, decision };
    }
    /**
     * Replaces opaque presentation metadata for one still-pending pause. The
     * execution identity may not change; a replacement is not a transfer.
     */
    update(request) {
        if (this.#closed)
            return { kind: 'closed' };
        if (request.revision !== this.#revision)
            return { kind: 'stale', reason: 'revision_mismatch' };
        if (!sameIdentity(request.expected, request.entry))
            return { kind: 'stale', reason: 'identity_mismatch' };
        const index = this.#pending.findIndex((pending) => sameIdentity(pending.entry, request.expected));
        if (index < 0)
            return { kind: 'stale', reason: 'identity_mismatch' };
        if (this.#pending[index] === this.#resolving)
            return { kind: 'stale', reason: 'identity_mismatch' };
        this.#pending[index] = { entry: freezeEntry(request.entry), callbacks: this.#pending[index].callbacks };
        this.#changed();
        return { kind: 'updated', revision: this.#revision };
    }
    /** Removes an exact pause after its owning run settles or is cancelled. */
    remove(request) {
        if (this.#closed)
            return { kind: 'closed' };
        if (request.revision !== this.#revision)
            return { kind: 'stale', reason: 'revision_mismatch' };
        const index = this.#pending.findIndex((pending) => sameIdentity(pending.entry, request.entry));
        if (index < 0)
            return { kind: 'stale', reason: 'identity_mismatch' };
        if (this.#pending[index] === this.#resolving)
            return { kind: 'stale', reason: 'identity_mismatch' };
        const [removed] = this.#pending.splice(index, 1);
        this.#changed();
        const releaseErrors = this.#release([removed], { kind: 'removed' });
        return {
            kind: 'removed',
            revision: this.#revision,
            ...(releaseErrors.length > 0 ? { releaseErrors } : {}),
        };
    }
    /**
     * Releases all pauses belonging to a terminal run, including hidden entries.
     * Lifecycle owners identify the run; UI actions still use revision fencing.
     */
    removeRun(runId) {
        const removed = this.#pending.filter((pending) => pending.entry.runId === runId);
        if (removed.length === 0)
            return Object.freeze([]);
        this.#pending = this.#pending.filter((pending) => pending.entry.runId !== runId);
        this.#changed();
        return this.#release(removed, { kind: 'removed' });
    }
    /**
     * Terminal and idempotent. Closing never interprets an answer: each run
     * owner gets an explicit release callback and can cancel its own lease.
     */
    close() {
        if (this.#closed)
            return Object.freeze([]);
        this.#closed = true;
        const pending = this.#pending;
        this.#pending = [];
        this.#changed();
        return this.#release(pending, { kind: 'closed' });
    }
    #release(pending, release) {
        const errors = [];
        for (const item of pending) {
            try {
                item.callbacks.onRelease?.(item.entry, release);
            }
            catch (error) {
                errors.push(error);
            }
        }
        return Object.freeze(errors);
    }
    #changed() {
        this.#revision += 1;
        this.#snapshot = freezeSnapshot(this.#revision, this.#pending, this.#closed);
        if (this.#notifying)
            return;
        this.#notifying = true;
        try {
            while ([...this.#listeners.values()].some((revision) => revision < this.#revision)) {
                for (const listener of [...this.#listeners.keys()]) {
                    if (this.#listeners.get(listener) === undefined || this.#listeners.get(listener) >= this.#revision)
                        continue;
                    // Mark before invoking so reentrant changes cannot notify this
                    // listener twice for the same externally visible revision.
                    this.#listeners.set(listener, this.#revision);
                    listener();
                }
            }
        }
        finally {
            this.#notifying = false;
        }
    }
}
//# sourceMappingURL=background-subagent-approval-queue.js.map