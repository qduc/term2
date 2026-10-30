/**
 * Transition validator for turn status.
 *
 * Only this class may mutate turn status. Resource cleanup remains with the
 * use case that acquired the resource.
 */
export class TurnStatusMachine {
    status = 'idle';
    nextGeneration = 0;
    activeLease;
    observer;
    constructor(observer) {
        this.observer = observer;
    }
    setObserver(observer) {
        this.observer = observer;
    }
    get current() {
        return this.status;
    }
    is(status) {
        return this.status === status;
    }
    beginTurn() {
        this.#assertTransition('idle', 'streaming');
        this.#setStatus('streaming');
        this.activeLease = { generation: ++this.nextGeneration };
        return this.activeLease;
    }
    requestApproval(lease) {
        if (!this.owns(lease))
            return;
        if (this.status !== 'streaming' && this.status !== 'continuing') {
            throw new Error(`Cannot request approval from ${this.status}`);
        }
        this.#setStatus('awaiting_approval');
    }
    beginContinuation() {
        this.#assertTransition('awaiting_approval', 'continuing');
        this.#setStatus('continuing');
        return this.activeLease;
    }
    /**
     * Transitions to idle when the current status is streaming or continuing.
     * When the status is awaiting_approval this is a no-op so the caller can
     * safely call complete() in a finally block without losing the pending
     * approval state.
     */
    complete(lease) {
        if (!this.owns(lease))
            return;
        if (this.status === 'streaming' || this.status === 'continuing') {
            this.#setStatus('idle');
            this.activeLease = undefined;
        }
    }
    abort() {
        this.#setStatus('idle');
        this.activeLease = undefined;
    }
    completeOutcome(outcome, lease) {
        if (!this.owns(lease))
            return { kind: 'none' };
        switch (outcome.kind) {
            case 'response':
                this.complete(lease);
                return { kind: 'emit_terminal', terminal: outcome.terminal };
            case 'approval_required':
                this.requestApproval(lease);
                return { kind: 'emit_terminal', terminal: outcome.terminal };
            case 'stale':
                return { kind: 'none' };
            case 'failed':
                this.complete(lease);
                return { kind: 'none' };
        }
    }
    completeContinuationOutcome(outcome, lease) {
        if (!this.owns(lease))
            return { kind: 'none' };
        if (this.status === 'continuing' || this.status === 'streaming') {
            return this.completeOutcome(outcome, lease);
        }
        switch (outcome.kind) {
            case 'response':
            case 'approval_required':
                return { kind: 'emit_terminal', terminal: outcome.terminal };
            case 'stale':
            case 'failed':
                return { kind: 'none' };
        }
    }
    owns(lease) {
        return lease === this.activeLease;
    }
    #assertTransition(from, to) {
        if (this.status !== from) {
            throw new Error(`Invalid transition: ${this.status} -> ${to}`);
        }
    }
    #setStatus(next) {
        if (this.status === next)
            return;
        const previous = this.status;
        this.status = next;
        try {
            this.observer?.({ previous, current: next });
        }
        catch {
            // Observers are diagnostic/lifecycle projections, never status owners.
        }
    }
}
//# sourceMappingURL=turn-status-machine.js.map