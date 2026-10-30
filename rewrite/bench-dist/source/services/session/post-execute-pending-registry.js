import { resolveSessionId } from './session-identity.js';
/**
 * Session/epoch-owned post-execute gates.
 *
 * This deliberately has no notion of an SDK dispatch barrier: each snapshot is
 * authoritative only for registrations visible at its revision. Callers must
 * re-read after every wakeup. Decisions validate the complete selected set
 * before settling any gate, so a stale or partial request cannot half-apply.
 */
export class PostExecutePendingRegistry {
    #sessionId;
    #epoch;
    #pending = new Map();
    #waiters = new Set();
    #revision = 0;
    #closed = false;
    constructor(options) {
        this.#sessionId = options.sessionId;
        this.#epoch = options.epoch;
    }
    get version() {
        return this.#revision;
    }
    snapshot() {
        return {
            sessionId: resolveSessionId(this.#sessionId),
            epoch: this.#epoch,
            revision: this.#revision,
            entries: [...this.#pending.values()].map(({ entry }) => ({ ...entry })),
            closed: this.#closed,
        };
    }
    entriesForRun(runId) {
        return this.snapshot().entries.filter((entry) => entry.runId === runId);
    }
    /** Resolves after a later state change, or immediately if one was already observed. */
    waitForChange(observedVersion) {
        if (this.#revision !== observedVersion)
            return Promise.resolve(this.#revision);
        return new Promise((resolve) => this.#waiters.add(resolve));
    }
    /** Cancellable subscription for consumers that race registry and local events. */
    watchForChange(observedVersion) {
        if (this.#revision !== observedVersion) {
            return { promise: Promise.resolve(this.#revision), unsubscribe: () => { } };
        }
        let active = true;
        let resolveWaiter;
        const promise = new Promise((resolve) => {
            resolveWaiter = resolve;
            this.#waiters.add(resolveWaiter);
        });
        return {
            promise,
            unsubscribe: () => {
                if (!active)
                    return;
                active = false;
                this.#waiters.delete(resolveWaiter);
            },
        };
    }
    register(input) {
        if (this.#closed)
            throw new Error('Post-execute pending registry is closed');
        const id = `${resolveSessionId(this.#sessionId)}:${this.#epoch}:${input.runId}:${input.toolCallId}`;
        if (this.#pending.has(id))
            throw new Error(`Duplicate active post-execute gate: ${id}`);
        return new Promise((settle) => {
            this.#pending.set(id, { entry: { ...input, id }, settle });
            this.#changed();
        });
    }
    decide(request) {
        if (this.#closed)
            return { kind: 'invalid', reason: 'closed' };
        if (request.revision !== this.#revision)
            return { kind: 'invalid', reason: 'revision_mismatch' };
        if (request.ids.length === 0)
            return { kind: 'invalid', reason: 'empty_selection' };
        const ids = [...request.ids];
        if (new Set(ids).size !== ids.length)
            return { kind: 'invalid', reason: 'duplicate_id' };
        if (ids.some((id) => !this.#pending.has(id)))
            return { kind: 'invalid', reason: 'unknown_entry' };
        const selected = ids.map((id) => this.#pending.get(id));
        for (const id of ids)
            this.#pending.delete(id);
        this.#changed();
        for (const pending of selected)
            pending.settle(request.decision);
        return { kind: 'settled', settledIds: ids };
    }
    /** Fail closed: unblock every held tool before the session can be replaced. */
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        const pending = [...this.#pending.values()];
        this.#pending.clear();
        this.#changed();
        for (const gate of pending)
            gate.settle('reject');
    }
    /** Fail closed for one terminal live run without closing its replacement session. */
    closeRun(runId) {
        const pending = [...this.#pending.entries()].filter(([, gate]) => gate.entry.runId === runId);
        if (pending.length === 0)
            return;
        for (const [id] of pending)
            this.#pending.delete(id);
        this.#changed();
        for (const [, gate] of pending)
            gate.settle('reject');
    }
    #changed() {
        this.#revision += 1;
        const waiters = [...this.#waiters];
        this.#waiters.clear();
        for (const wake of waiters)
            wake(this.#revision);
    }
}
//# sourceMappingURL=post-execute-pending-registry.js.map