export type GatewayWorkerHandle = {
  close: () => Promise<void> | void;
};

export class GatewayLifecycle {
  #state: 'running' | 'draining' | 'stopped' = 'running';
  readonly #workers = new Set<GatewayWorkerHandle>();

  get state(): 'running' | 'draining' | 'stopped' {
    return this.#state;
  }
  get activeWorkerCount(): number {
    return this.#workers.size;
  }
  assertAccepting(): void {
    if (this.#state !== 'running') throw new Error('gateway is not accepting sessions');
  }

  registerWorker(worker: GatewayWorkerHandle): () => void {
    this.assertAccepting();
    this.#workers.add(worker);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#workers.delete(worker);
    };
  }

  async shutdown(graceMs: number): Promise<void> {
    if (this.#state === 'stopped') return;
    this.#state = 'draining';
    const workers = [...this.#workers];
    await Promise.race([
      Promise.all(workers.map((worker) => worker.close())),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, graceMs))),
    ]);
    this.#state = 'stopped';
    this.#workers.clear();
  }
}
