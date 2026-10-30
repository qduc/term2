/**
 * Owns generation and stale-attempt protection.
 *
 * Any mutation derived from asynchronous provider work must be guarded
 * through this abstraction.
 */
export class GenerationGuard {
    #generation = 0;
    get currentGeneration() {
        return this.#generation;
    }
    capture() {
        this.#generation++;
        return this.#generation;
    }
    isCurrent(token) {
        return token === this.#generation;
    }
    invalidate() {
        this.#generation++;
    }
    runIfCurrent(token, mutation) {
        if (!this.isCurrent(token))
            return false;
        mutation();
        return true;
    }
}
//# sourceMappingURL=generation-guard.js.map