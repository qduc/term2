export class BackgroundShellOutputStoreError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BackgroundShellOutputStoreError';
    }
}
export class BackgroundShellOutputStore {
    #jobs = new Map();
    /** Settled job ids in close order; retention evicts from the front. */
    #settled = [];
    #maxBytes;
    #maxLines;
    #maxRetainedJobs;
    constructor(options = {}) {
        this.#maxBytes = options.maxBytes ?? 256 * 1024;
        this.#maxLines = options.maxLines ?? 2000;
        this.#maxRetainedJobs = options.maxRetainedJobs ?? 20;
        if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 0) {
            throw new RangeError('maxBytes must be a non-negative integer.');
        }
        if (!Number.isInteger(this.#maxLines) || this.#maxLines < 0) {
            throw new RangeError('maxLines must be a non-negative integer.');
        }
        if (!Number.isInteger(this.#maxRetainedJobs) || this.#maxRetainedJobs < 0) {
            throw new RangeError('maxRetainedJobs must be a non-negative integer.');
        }
    }
    /** Begins a job's output stream. Throws if the job id already has one. */
    open(jobId) {
        if (this.#jobs.has(jobId)) {
            throw new BackgroundShellOutputStoreError(`Output stream already open for job ${jobId}.`);
        }
        this.#jobs.set(jobId, {
            records: [],
            remainder: {},
            remainderSeq: {},
            remainderOrder: [],
            droppedBytes: 0,
            droppedLines: 0,
            closed: false,
            nextSeq: 0,
        });
    }
    /**
     * Appends one chunk of a job's output. Chunks may arrive on arbitrary byte
     * boundaries; complete lines enter the buffer, the partial remainder is held
     * per stream. Returns the newly completed lines, including lines evicted
     * from retention during this push, for live observers. Throws if the job is
     * unknown or already closed.
     */
    push(jobId, stream, text) {
        const job = this.#jobs.get(jobId);
        if (!job)
            throw new BackgroundShellOutputStoreError(`No output stream open for job ${jobId}.`);
        if (job.closed)
            throw new BackgroundShellOutputStoreError(`Output stream for job ${jobId} is already closed.`);
        if (text.length === 0)
            return [];
        const completed = [];
        let pending = (job.remainder[stream] ?? '') + text;
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
            const line = { stream, text: pending.slice(0, newline) };
            job.records.push({ ...line, seq: job.nextSeq++, terminated: true });
            completed.push(line);
            pending = pending.slice(newline + 1);
            newline = pending.indexOf('\n');
        }
        job.remainder[stream] = pending;
        if (pending.length > 0) {
            job.remainderSeq[stream] = job.nextSeq++;
            if (!job.remainderOrder.includes(stream))
                job.remainderOrder.push(stream);
        }
        else {
            delete job.remainder[stream];
            delete job.remainderSeq[stream];
            const index = job.remainderOrder.indexOf(stream);
            if (index !== -1)
                job.remainderOrder.splice(index, 1);
        }
        this.#evictToFit(job);
        return completed;
    }
    /**
     * Ends a job's output stream: flushes each pending partial line as a final
     * record and marks the job settled, subject to retention eviction. Returns
     * true if this call settled the stream; a second close is a no-op returning
     * false. Throws if the job was never opened.
     */
    close(jobId) {
        const job = this.#jobs.get(jobId);
        if (!job)
            throw new BackgroundShellOutputStoreError(`No output stream open for job ${jobId}.`);
        if (job.closed)
            return false;
        for (const stream of job.remainderOrder) {
            const text = job.remainder[stream];
            if (text !== undefined && text.length > 0) {
                // Keep the remainder's own arrival position: the flushed line completes
                // at EOF but its bytes arrived when the remainder was last extended.
                job.records.push({ stream, text, seq: job.remainderSeq[stream] ?? 0, terminated: false });
            }
        }
        job.remainder = {};
        job.remainderSeq = {};
        job.remainderOrder = [];
        job.closed = true;
        this.#evictToFit(job);
        this.#settled.push(jobId);
        while (this.#settled.length > this.#maxRetainedJobs) {
            const evicted = this.#settled.shift();
            if (evicted)
                this.#jobs.delete(evicted);
        }
        return true;
    }
    /** Reads the retained complete lines of a job. Returns undefined for unknown jobs. */
    readLines(jobId) {
        const job = this.#jobs.get(jobId);
        if (!job)
            return undefined;
        return {
            lines: job.records.map(({ stream, text }) => ({ stream, text })),
            droppedBytes: job.droppedBytes,
            droppedLines: job.droppedLines,
            closed: job.closed,
        };
    }
    /**
     * Reads the newest retained bytes of a job as text, in arrival order, cut to
     * the requested window (default: the store's byte cap). Includes each
     * stream's pending partial line. Returns undefined for unknown jobs.
     */
    readTail(jobId, maxBytes = this.#maxBytes) {
        if (!Number.isInteger(maxBytes) || maxBytes < 0) {
            throw new RangeError('maxBytes must be a non-negative integer.');
        }
        const job = this.#jobs.get(jobId);
        if (!job)
            return undefined;
        const segments = [];
        for (const record of job.records) {
            segments.push({ seq: record.seq, text: record.text, newline: record.terminated });
        }
        for (const stream of job.remainderOrder) {
            const text = job.remainder[stream];
            if (text !== undefined && text.length > 0) {
                segments.push({ seq: job.remainderSeq[stream] ?? 0, text, newline: false });
            }
        }
        segments.sort((a, b) => a.seq - b.seq);
        let text = '';
        for (const segment of segments)
            text += segment.newline ? `${segment.text}\n` : segment.text;
        if (text.length > maxBytes)
            text = text.slice(text.length - maxBytes);
        return { text, droppedBytes: job.droppedBytes, droppedLines: job.droppedLines, closed: job.closed };
    }
    /** Retained bytes per job, including pending partial-line text. */
    #retainedBytes(job) {
        let bytes = 0;
        for (const record of job.records)
            bytes += record.text.length;
        for (const stream of job.remainderOrder)
            bytes += job.remainder[stream]?.length ?? 0;
        return bytes;
    }
    /**
     * Drops from the head of the retained stream until both caps hold. Whole
     * lines go first (they are the oldest content); a byte overflow that whole
     * lines cannot fix is a single pending partial line longer than the cap, in
     * which case its oldest bytes are dropped and its newest tail is kept. Every
     * drop is accounted for in `droppedBytes`/`droppedLines`.
     */
    #evictToFit(job) {
        while (job.records.length > 0 &&
            (this.#retainedBytes(job) > this.#maxBytes || job.records.length > this.#maxLines)) {
            const head = job.records.shift();
            if (head) {
                job.droppedBytes += head.text.length;
                job.droppedLines += 1;
            }
        }
        let overflow = this.#retainedBytes(job) - this.#maxBytes;
        for (const stream of [...job.remainderOrder]) {
            if (overflow <= 0)
                break;
            const text = job.remainder[stream];
            if (text === undefined || text.length === 0)
                continue;
            const drop = Math.min(text.length, overflow);
            job.remainder[stream] = text.slice(drop);
            job.droppedBytes += drop;
            overflow -= drop;
        }
        for (const stream of [...job.remainderOrder]) {
            if ((job.remainder[stream]?.length ?? 0) === 0) {
                delete job.remainder[stream];
                delete job.remainderSeq[stream];
                const index = job.remainderOrder.indexOf(stream);
                if (index !== -1)
                    job.remainderOrder.splice(index, 1);
            }
        }
    }
}
//# sourceMappingURL=background-shell-output-store.js.map