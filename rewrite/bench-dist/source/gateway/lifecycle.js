export class GatewayLifecycle {
    #state = 'running';
    #workers = new Set();
    get state() {
        return this.#state;
    }
    get activeWorkerCount() {
        return this.#workers.size;
    }
    assertAccepting() {
        if (this.#state !== 'running')
            throw new Error('gateway is not accepting sessions');
    }
    registerWorker(worker) {
        this.assertAccepting();
        this.#workers.add(worker);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.#workers.delete(worker);
        };
    }
    async shutdown(graceMs) {
        if (this.#state === 'stopped')
            return;
        this.#state = 'draining';
        const workers = [...this.#workers];
        await Promise.race([
            Promise.all(workers.map((worker) => worker.close())),
            new Promise((resolve) => setTimeout(resolve, Math.max(0, graceMs))),
        ]);
        this.#state = 'stopped';
        this.#workers.clear();
    }
}
//# sourceMappingURL=lifecycle.js.map