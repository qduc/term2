/**
 * The observation mailbox for one foreground turn. Its consumer starts once
 * and stays alive through approval and post-execute waits. Callers observe
 * buffered events, pending decisions, or the runtime's terminal result.
 */
export class LiveRun {
    runId;
    pending;
    #events = [];
    #waiters = new Set();
    #completion;
    #result;
    #error;
    #finished = false;
    #cancelled = false;
    #approval;
    constructor(runId, pending, consume) {
        this.runId = runId;
        this.pending = pending;
        this.#completion = Promise.resolve()
            .then(() => {
            if (this.#cancelled)
                throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
            return consume((event) => this.#emit(event));
        })
            .then((result) => {
            if (this.#cancelled)
                return result;
            this.#result = result;
            this.#finished = true;
            this.pending.closeRun(this.runId);
            this.#changed();
            return result;
        }, (error) => {
            if (this.#cancelled)
                throw error;
            this.#error = error;
            this.#finished = true;
            this.pending.closeRun(this.runId);
            this.#changed();
            throw error;
        });
        // `next()` reports the stored failure. Keep a background rejection from
        // becoming unhandled while the application is showing an approval prompt.
        void this.#completion.catch(() => undefined);
    }
    get completion() {
        return this.#completion;
    }
    async next() {
        while (true) {
            const event = this.#events.shift();
            if (event !== undefined)
                return { kind: 'event', event };
            if (this.#cancelled)
                return { kind: 'cancelled' };
            if (this.#error !== undefined)
                throw this.#error;
            if (this.#finished)
                return { kind: 'completed', result: this.#result };
            if (this.#approval)
                return { kind: 'approval_required', terminal: this.#approval };
            const entries = this.pending.entriesForRun(this.runId);
            if (entries.length > 0)
                return { kind: 'post_execute_approval_required', entries };
            if (this.pending.snapshot().closed)
                throw new Error('Post-execute live run closed');
            const observedVersion = this.pending.version;
            const localChange = this.#waitForChange();
            const pendingChange = this.pending.watchForChange(observedVersion);
            try {
                await Promise.race([localChange.promise, pendingChange.promise]);
            }
            finally {
                localChange.unsubscribe();
                pendingChange.unsubscribe();
            }
        }
    }
    pause(terminal) {
        this.#approval = terminal;
        this.#changed();
    }
    resume() {
        this.#approval = undefined;
        this.#changed();
    }
    #emit(event) {
        if (this.#cancelled)
            return;
        this.#events.push(event);
        this.#changed();
    }
    #waitForChange() {
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
    #changed() {
        const waiters = [...this.#waiters];
        this.#waiters.clear();
        for (const wake of waiters)
            wake();
    }
    /** Stop projecting this run and fail-close every gate it owns. */
    cancel() {
        if (this.#cancelled || this.#finished)
            return;
        this.#cancelled = true;
        this.pending.closeRun(this.runId);
        this.#changed();
    }
}
//# sourceMappingURL=live-run.js.map