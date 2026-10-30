/**
 * Owns the pending-input mailbox and its turn/segment settlement rules.
 *
 * Segment state only covers a running or paused segment. The caller-owned
 * open-turn state also keeps inputs steerable in gaps where no segment exists,
 * such as startup before the first request or retry backoff. Only the caller
 * that opened the turn knows those gaps still belong to it.
 */
export class TurnInputMailbox {
    #pending = [];
    #turnOpen = false;
    #segmentInFlight = false;
    /** A paused segment (for example, awaiting approval) can resume at a boundary. */
    #segmentPaused = false;
    #diagnostic;
    constructor(diagnostic) {
        this.#diagnostic = diagnostic;
    }
    openTurn() {
        this.#release({ reason: 'superseded_by_new_turn' });
        this.#turnOpen = true;
        this.#segmentPaused = false;
    }
    closeTurn() {
        this.#turnOpen = false;
        this.#segmentPaused = false;
        this.#release({ reason: 'turn_closed' });
    }
    abortTurn() {
        this.#turnOpen = false;
        this.#segmentPaused = false;
        this.#release({ reason: 'aborted' });
    }
    startStream() {
        this.#segmentPaused = false;
        if (!this.#turnOpen)
            this.#release({ reason: 'superseded_by_new_turn' });
    }
    startSegment() {
        this.#segmentInFlight = true;
        this.#segmentPaused = false;
    }
    settleSegment(input) {
        this.#segmentInFlight = false;
        this.#segmentPaused = input.paused;
        if (input.paused || this.#turnOpen)
            return;
        this.#release(input.reason);
    }
    offer(items, options) {
        if (items.length === 0 || (!this.#turnOpen && !this.#segmentInFlight && !this.#segmentPaused)) {
            return Promise.resolve('released');
        }
        return new Promise((resolve) => {
            this.#pending.push({ id: options?.id, items, resolve });
        });
    }
    enqueueInternal(item) {
        this.#pending.push({ items: [item], resolve: () => undefined });
    }
    retract(id) {
        const index = this.#pending.findIndex((item) => item.id === id);
        if (index < 0)
            return false;
        const [item] = this.#pending.splice(index, 1);
        item.resolve('retracted');
        return true;
    }
    edit(id, items) {
        const index = this.#pending.findIndex((item) => item.id === id);
        if (index < 0)
            return false;
        this.#pending[index] = { ...this.#pending[index], items };
        return true;
    }
    /** Drain synchronously in FIFO order; the caller supplies history/event effects. */
    admitAtRequestBoundary(append, turnCount) {
        if (this.#pending.length === 0)
            return;
        const admitted = this.#pending;
        this.#pending = [];
        this.#diagnostic?.('Steer admitted at request boundary', { admitted: admitted.length, turnCount });
        for (const entry of admitted) {
            for (const item of entry.items)
                append(item);
            entry.resolve('admitted');
        }
    }
    #release(reason) {
        const pending = this.#pending;
        this.#pending = [];
        if (pending.length > 0)
            this.#diagnostic?.('Steer released at run end', { released: pending.length, ...reason });
        for (const entry of pending)
            entry.resolve('released');
    }
}
//# sourceMappingURL=turn-input-mailbox.js.map