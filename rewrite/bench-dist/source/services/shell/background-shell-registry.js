import { randomUUID } from 'node:crypto';
export class BackgroundShellRegistryCapacityError extends Error {
    constructor(maxConcurrentJobs) {
        super(`Background shell job limit reached (${maxConcurrentJobs}).`);
        this.name = 'BackgroundShellRegistryCapacityError';
    }
}
export class BackgroundShellRegistryDisposedError extends Error {
    constructor() {
        super('Background shell registry has been disposed.');
        this.name = 'BackgroundShellRegistryDisposedError';
    }
}
/**
 * Session-owned lifecycle for shell processes whose tool invocation has
 * already returned. The registry deliberately owns cancellation and retention
 * so callers cannot accidentally leave an orphaned process behind.
 */
export class BackgroundShellRegistry {
    #jobs = new Map();
    #foreground = new Map();
    #terminalJobIds = [];
    #maxConcurrentJobs;
    #maxRetainedJobs;
    #createId;
    #now;
    #eventSink;
    #runningJobs = 0;
    #disposed = false;
    #disposePromise;
    constructor(options = {}) {
        this.#maxConcurrentJobs = options.maxConcurrentJobs ?? 4;
        this.#maxRetainedJobs = options.maxRetainedJobs ?? 20;
        this.#createId = options.createId ?? randomUUID;
        this.#now = options.now ?? Date.now;
        this.#eventSink = options.onEvent;
        if (!Number.isInteger(this.#maxConcurrentJobs) || this.#maxConcurrentJobs < 1) {
            throw new RangeError('maxConcurrentJobs must be a positive integer.');
        }
        if (!Number.isInteger(this.#maxRetainedJobs) || this.#maxRetainedJobs < 0) {
            throw new RangeError('maxRetainedJobs must be a non-negative integer.');
        }
    }
    launch(options) {
        if (this.#disposed)
            throw new BackgroundShellRegistryDisposedError();
        if (this.#runningJobs >= this.#maxConcurrentJobs) {
            throw new BackgroundShellRegistryCapacityError(this.#maxConcurrentJobs);
        }
        const job = {
            id: this.#createId(),
            command: options.command,
            status: 'running',
            startedAt: this.#now(),
        };
        job.lastActivityAt = job.startedAt;
        job.lastObservation = { kind: 'shell_started', at: job.startedAt };
        const controller = new AbortController();
        this.#runningJobs += 1;
        const record = {
            job,
            controller,
            settled: Promise.resolve(job),
        };
        this.#jobs.set(job.id, record);
        options.onStarted?.(job.id);
        record.settled = this.#settle(record, options);
        this.#emit({ type: 'background_shell_started', jobId: job.id, command: job.command });
        return { ...job, settled: record.settled };
    }
    /**
     * Starts a root shell process under a detachable foreground lease. The lease
     * is intentionally invisible to `list()` until `adoptForeground` succeeds.
     */
    startForeground(options) {
        if (this.#disposed)
            throw new BackgroundShellRegistryDisposedError();
        if (this.#foreground.has(options.callId)) {
            throw new Error(`Foreground shell lease already exists for tool call ${options.callId}.`);
        }
        const job = {
            id: this.#createId(),
            command: options.command,
            status: 'running',
            startedAt: this.#now(),
        };
        job.lastActivityAt = job.startedAt;
        job.lastObservation = { kind: 'shell_started', at: job.startedAt };
        const controller = new AbortController();
        let resolveForegroundResult;
        let rejectForegroundResult;
        const foregroundResult = new Promise((resolve, reject) => {
            resolveForegroundResult = resolve;
            rejectForegroundResult = reject;
        });
        const abortFromParent = () => controller.abort();
        if (options.parentSignal?.aborted)
            abortFromParent();
        else
            options.parentSignal?.addEventListener('abort', abortFromParent, { once: true });
        const record = {
            job,
            controller,
            callId: options.callId,
            adopted: false,
            onAdopted: options.onAdopted,
            detachParentAbort: () => options.parentSignal?.removeEventListener('abort', abortFromParent),
            resolveForegroundResult,
            rejectForegroundResult,
            settled: Promise.resolve(job),
        };
        this.#foreground.set(options.callId, record);
        options.onStarted?.(job.id);
        record.settled = this.#settleForeground(record, options);
        return {
            callId: record.callId,
            jobId: job.id,
            command: job.command,
            startedAt: job.startedAt,
            status: 'running',
            foregroundResult,
            settled: record.settled,
        };
    }
    getForeground(callId) {
        const record = this.#foreground.get(callId);
        if (!record || record.job.status !== 'running')
            return undefined;
        return {
            callId: record.callId,
            jobId: record.job.id,
            command: record.job.command,
            status: 'running',
            startedAt: record.job.startedAt,
        };
    }
    listForeground() {
        return [...this.#foreground.values()]
            .filter((record) => record.job.status === 'running')
            .map((record) => ({
            callId: record.callId,
            jobId: record.job.id,
            command: record.job.command,
            status: 'running',
            startedAt: record.job.startedAt,
        }));
    }
    /** Atomically publishes a running foreground lease as a background job. */
    adoptForeground(callId) {
        const record = this.#foreground.get(callId);
        if (!record || record.job.status !== 'running') {
            throw new Error(`No running foreground shell lease exists for tool call ${callId}.`);
        }
        if (record.controller.signal.aborted) {
            throw new Error(`Foreground shell lease for tool call ${callId} is already aborting.`);
        }
        if (this.#disposed)
            throw new BackgroundShellRegistryDisposedError();
        if (this.#runningJobs >= this.#maxConcurrentJobs) {
            throw new BackgroundShellRegistryCapacityError(this.#maxConcurrentJobs);
        }
        // All validation precedes this ownership change. JavaScript's synchronous
        // turn makes these mutations atomic with respect to process settlement.
        record.detachParentAbort();
        record.adopted = true;
        this.#foreground.delete(callId);
        this.#jobs.set(record.job.id, record);
        this.#runningJobs += 1;
        const result = { jobId: record.job.id, status: 'running' };
        try {
            record.onAdopted?.();
        }
        catch {
            // Lifecycle ownership has already changed; observers cannot roll it back.
        }
        record.resolveForegroundResult(result);
        this.#emit({ type: 'background_shell_started', jobId: record.job.id, command: record.job.command });
        return result;
    }
    get(id) {
        const job = this.#jobs.get(id)?.job;
        return job ? { ...job } : undefined;
    }
    whenSettled(id) {
        return this.#jobs.get(id)?.settled;
    }
    setEventSink(eventSink) {
        this.#eventSink = eventSink;
    }
    list() {
        return [...this.#jobs.values()].map(({ job }) => ({ ...job }));
    }
    cancel(id) {
        const record = this.#jobs.get(id);
        if (!record || record.job.status !== 'running')
            return false;
        record.job.status = 'cancelling';
        record.job.lastActivityAt = this.#now();
        record.job.lastObservation = { kind: 'stop_requested', at: record.job.lastActivityAt };
        record.controller.abort();
        return true;
    }
    /** Records that a running process produced output without retaining the chunk. */
    recordOutputChunk(id) {
        const record = this.#jobs.get(id) ?? [...this.#foreground.values()].find((candidate) => candidate.job.id === id);
        if (!record || (record.job.status !== 'running' && record.job.status !== 'cancelling'))
            return false;
        if (record.job.status !== 'cancelling') {
            record.job.lastActivityAt = this.#now();
            record.job.lastObservation = { kind: 'shell_output_received', at: record.job.lastActivityAt };
        }
        return true;
    }
    /** Cancels every running process and permanently rejects new launches. */
    dispose() {
        if (this.#disposePromise)
            return this.#disposePromise;
        this.#disposed = true;
        for (const { job } of this.#jobs.values()) {
            this.cancel(job.id);
        }
        const foreground = [...this.#foreground.values()];
        for (const record of foreground)
            record.controller.abort();
        this.#disposePromise = Promise.allSettled([
            ...[...this.#jobs.values()].map((record) => record.settled),
            ...foreground.map((record) => record.settled),
        ]).then(() => { });
        return this.#disposePromise;
    }
    async #settle(record, options) {
        let result;
        let failure;
        try {
            result = await options.run(record.controller.signal);
        }
        catch (error) {
            failure = error;
        }
        try {
            await options.onSettled?.();
        }
        catch (error) {
            failure ??= error;
        }
        const { job } = record;
        this.#runningJobs -= 1;
        job.completedAt = this.#now();
        job.lastActivityAt = job.completedAt;
        job.lastObservation = { kind: 'settled', at: job.completedAt };
        if (record.controller.signal.aborted) {
            job.status = 'cancelled';
            if (result !== undefined)
                job.result = result;
        }
        else if (failure !== undefined) {
            job.status = 'failed';
            job.error = errorMessage(failure);
        }
        else {
            job.status = options.resultToStatus?.(result) ?? 'completed';
            job.result = result;
        }
        this.#retainTerminal(job.id);
        this.#emit({
            type: 'background_shell_completed',
            jobId: job.id,
            command: job.command,
            status: job.status,
            ...(job.result === undefined ? {} : { output: job.result }),
            ...(job.error === undefined ? {} : { error: job.error }),
        });
        return { ...job };
    }
    async #settleForeground(record, options) {
        let result;
        let failure;
        try {
            result = await options.run(record.controller.signal);
        }
        catch (error) {
            failure = error;
        }
        try {
            await options.onSettled?.();
        }
        catch (error) {
            failure ??= error;
        }
        const { job } = record;
        job.completedAt = this.#now();
        job.lastActivityAt = job.completedAt;
        job.lastObservation = { kind: 'settled', at: job.completedAt };
        if (record.controller.signal.aborted) {
            job.status = 'cancelled';
            if (result !== undefined)
                job.result = result;
        }
        else if (failure !== undefined) {
            job.status = 'failed';
            job.error = errorMessage(failure);
        }
        else {
            job.status = options.resultToStatus?.(result) ?? 'completed';
            job.result = result;
        }
        if (record.adopted) {
            this.#runningJobs -= 1;
            this.#retainTerminal(job.id);
            this.#emit({
                type: 'background_shell_completed',
                jobId: job.id,
                command: job.command,
                status: job.status,
                ...(job.result === undefined ? {} : { output: job.result }),
                ...(job.error === undefined ? {} : { error: job.error }),
            });
        }
        else {
            record.detachParentAbort();
            this.#foreground.delete(record.callId);
            if (failure !== undefined)
                record.rejectForegroundResult(failure);
            else
                record.resolveForegroundResult(result);
        }
        return { ...job };
    }
    #retainTerminal(id) {
        this.#terminalJobIds.push(id);
        while (this.#terminalJobIds.length > this.#maxRetainedJobs) {
            const evicted = this.#terminalJobIds.shift();
            if (evicted)
                this.#jobs.delete(evicted);
        }
    }
    #emit(event) {
        try {
            this.#eventSink?.(event);
        }
        catch {
            // Event consumers are observational and must not change process lifetime.
        }
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=background-shell-registry.js.map