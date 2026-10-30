/**
 * Serializes sandbox-network approval requests for one interactive surface.
 *
 * The coordinator owns the request lifetime: one request is observable at a
 * time, and teardown fails closed for both the active request and every queued
 * request. Its consumer only needs to render `activeRequest` and submit an
 * answer for it.
 */
export class SandboxNetworkApprovalCoordinator {
    #active = null;
    #queue = [];
    #listeners = new Set();
    #snapshot = { activeRequest: null };
    #disposed = false;
    getSnapshot() {
        return this.#snapshot;
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }
    request(request) {
        if (this.#disposed)
            return Promise.resolve('deny');
        return new Promise((resolve) => {
            this.#queue.push({ request, resolve });
            this.#showNext();
        });
    }
    resolve(request, answer) {
        const active = this.#active;
        if (!active || active.request !== request || this.#disposed)
            return;
        this.#active = null;
        this.#showNext();
        active.resolve(answer);
    }
    cancel(request) {
        if (this.#disposed)
            return false;
        if (this.#active?.request === request) {
            const active = this.#active;
            this.#active = null;
            this.#showNext();
            active.resolve('deny');
            return true;
        }
        const index = this.#queue.findIndex((pending) => pending.request === request);
        if (index < 0)
            return false;
        const [pending] = this.#queue.splice(index, 1);
        pending.resolve('deny');
        return true;
    }
    dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        const pending = [...(this.#active ? [this.#active] : []), ...this.#queue];
        this.#active = null;
        this.#queue = [];
        this.#setSnapshot(null);
        for (const item of pending)
            item.resolve('deny');
    }
    #showNext() {
        if (this.#active || this.#disposed)
            return;
        const next = this.#queue.shift() ?? null;
        this.#active = next;
        this.#setSnapshot(next?.request ?? null);
    }
    #setSnapshot(activeRequest) {
        if (this.#snapshot.activeRequest === activeRequest)
            return;
        this.#snapshot = { activeRequest };
        for (const listener of this.#listeners)
            listener();
    }
}
//# sourceMappingURL=sandbox-network-approval-coordinator.js.map