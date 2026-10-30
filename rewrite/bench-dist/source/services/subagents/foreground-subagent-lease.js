/**
 * Owns the cancellation link and resumable pause of one foreground child run.
 *
 * This deliberately has no UI knowledge.  The foreground runner decides how
 * to surface a pause before adoption; after adoption the session resolves the
 * snapshot through this narrow capability and the original child continuation
 * is resumed exactly once.
 */
export class ForegroundSubagentLease {
    #controller = new AbortController();
    #runId;
    #model;
    #onPendingApprovalReleased;
    #detachParentAbort;
    #adopted = false;
    #settled = false;
    #adoptionWaiters = [];
    #generation = 0;
    #pending;
    constructor({ runId, parentSignal, model, onPendingApprovalReleased, }) {
        this.#runId = runId;
        this.#model = model;
        this.#onPendingApprovalReleased = onPendingApprovalReleased;
        const abortFromParent = () => this.#controller.abort();
        if (parentSignal?.aborted)
            abortFromParent();
        else
            parentSignal?.addEventListener('abort', abortFromParent, { once: true });
        this.#detachParentAbort = () => parentSignal?.removeEventListener('abort', abortFromParent);
    }
    get signal() {
        return this.#controller.signal;
    }
    get adopted() {
        return this.#adopted;
    }
    get runId() {
        return this.#runId;
    }
    get model() {
        return this.#model;
    }
    /** Update the launch model only before ownership transfers to the background registry. */
    setModel(model) {
        if (this.#adopted || this.#settled)
            throw new Error('Cannot change the model of an adopted subagent');
        this.#model = model;
    }
    get settled() {
        return this.#settled;
    }
    /** Called only after registry capacity/lifetime validation succeeds. */
    adopt() {
        if (this.#adopted)
            throw new Error(`Foreground subagent lease ${this.#runId} is already adopted.`);
        if (this.#settled)
            throw new Error(`Foreground subagent lease ${this.#runId} has already settled.`);
        if (this.#controller.signal.aborted)
            throw new Error(`Foreground subagent lease ${this.#runId} is aborting.`);
        this.#detachParentAbort?.();
        this.#detachParentAbort = undefined;
        this.#adopted = true;
        for (const resolve of this.#adoptionWaiters.splice(0))
            resolve(true);
    }
    /** Resolves once the registry adopts the lease, or false if it settles first. */
    waitForAdoption() {
        if (this.#adopted)
            return Promise.resolve(true);
        if (this.#settled || this.#controller.signal.aborted)
            return Promise.resolve(false);
        return new Promise((resolve) => this.#adoptionWaiters.push(resolve));
    }
    cancel() {
        this.#controller.abort();
        for (const resolve of this.#adoptionWaiters.splice(0))
            resolve(false);
        this.#releasePending(false);
    }
    settle() {
        if (this.#settled)
            return;
        this.#settled = true;
        this.#detachParentAbort?.();
        this.#detachParentAbort = undefined;
        for (const resolve of this.#adoptionWaiters.splice(0))
            resolve(false);
        this.#releasePending(false);
    }
    /**
     * Holds one child continuation. Returns false while the caller must retain
     * foreground ownership, and waits for a background decision after adoption.
     */
    async waitForBackgroundApproval(handle, interruption) {
        return this.#waitForBackgroundApproval(handle, interruption);
    }
    /**
     * Like {@link waitForBackgroundApproval}, but retains the exact child-loop
     * continuation. It is intentionally a raw, already-classified decision
     * seam: approval policy and presentation belong to the session layer.
     */
    async waitForBackgroundContinuation(handle, interruption, resume, onPending) {
        return this.#waitForBackgroundApproval(handle, interruption, resume, onPending);
    }
    /** Keeps a host-arbitrated child pause inside its original foreground call. */
    async waitForForegroundContinuation(handle, interruption, resume, onPending, onPause) {
        if (this.#adopted || this.#settled || this.#controller.signal.aborted)
            return false;
        if (this.#pending)
            throw new Error(`Foreground subagent lease ${this.#runId} already has a pending approval.`);
        let pending;
        const resumed = new Promise((resolve, reject) => {
            this.#generation += 1;
            pending = { handle, interruption, owner: 'foreground', resume, resolve, reject };
            this.#pending = pending;
        });
        const snapshot = { runId: this.#runId, generation: this.#generation, interruption };
        onPending(snapshot);
        void Promise.resolve()
            .then(() => onPause(snapshot))
            .then(() => {
            if (this.#pending === pending)
                this.#releasePending(false);
        })
            .catch((error) => {
            if (this.#pending === pending)
                this.#pending = undefined;
            pending.reject(error);
        });
        return (await resumed) && !this.#controller.signal.aborted;
    }
    async #waitForBackgroundApproval(handle, interruption, resume, onPending) {
        if (!this.#adopted)
            return false;
        if (this.#pending)
            throw new Error(`Foreground subagent lease ${this.#runId} already has a pending approval.`);
        const resumed = await new Promise((resolve, reject) => {
            this.#generation += 1;
            this.#pending = { handle, interruption, owner: 'background', resolve, reject, ...(resume ? { resume } : {}) };
            onPending?.({ runId: this.#runId, generation: this.#generation, interruption });
        });
        return resumed && !this.#controller.signal.aborted;
    }
    getPendingApproval() {
        if (!this.#pending)
            return undefined;
        return { runId: this.#runId, generation: this.#generation, interruption: this.#pending.interruption };
    }
    /**
     * Applies session policy to one exact pause, then resumes the child loop
     * once. This deliberately accepts a callback rather than an approve/reject
     * enum: policy owns all approval variants and is the only layer allowed to
     * touch the opaque continuation handle.
     *
     * Returns false for stale, cancelled, or already-consumed pauses. A policy
     * exception leaves the pause intact, letting its queue retain ownership.
     */
    applyBackgroundApproval(expected, apply) {
        return this.#applyApproval(expected, 'background', apply);
    }
    applyForegroundApproval(expected, apply) {
        return this.#applyApproval(expected, 'foreground', apply);
    }
    #applyApproval(expected, owner, apply) {
        const pending = this.#pending;
        if (!pending ||
            pending.owner !== owner ||
            (owner === 'background' ? !this.#adopted : this.#adopted) ||
            expected.runId !== this.#runId ||
            expected.generation !== this.#generation ||
            expected.interruption !== pending.interruption ||
            this.#controller.signal.aborted)
            return false;
        const applied = apply({
            runId: this.#runId,
            generation: this.#generation,
            handle: pending.handle,
            interruption: pending.interruption,
        });
        if (!applied)
            return false;
        this.#pending = undefined;
        // Keep the loop resume paired with the handle decision. Callers must not
        // resume a sibling interruption or manufacture a new run.
        try {
            pending.resume?.();
            pending.resolve(true);
        }
        catch (error) {
            // The policy already decided the opaque handle. Retrying this queue head
            // would apply that decision twice, so consume it and fail the retained
            // child execution through its durable async terminal path instead.
            pending.reject(error);
        }
        return true;
    }
    #releasePending(resumed) {
        const pending = this.#pending;
        this.#pending = undefined;
        if (pending)
            this.#onPendingApprovalReleased?.(pending.interruption);
        pending?.resolve(resumed);
    }
}
//# sourceMappingURL=foreground-subagent-lease.js.map