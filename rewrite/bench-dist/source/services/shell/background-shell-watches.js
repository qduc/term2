export class BackgroundShellWatchesError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BackgroundShellWatchesError';
    }
}
const DEFAULT_IDLE_MS = 1500;
/** Cap on `matchedLines` and on retained pending text, ~4 KB. */
const MAX_MATCHED_TEXT = 4096;
export class BackgroundShellWatches {
    #store;
    #scheduler;
    #onFiring;
    #watches = new Map();
    #nextWatchId = 0;
    constructor(options) {
        this.#store = options.store;
        this.#scheduler = options.scheduler;
        this.#onFiring = options.onFiring;
    }
    /**
     * Replaces the firing subscriber. The phase-5 shell-tool wiring installs the
     * conversation-lane sink here when the session attaches it, so firings enter
     * the same durable lane as job-completion events.
     */
    setOnFiring(callback) {
        this.#onFiring = callback;
    }
    /** Begins a job's output stream; delegates to the store. */
    open(jobId) {
        this.#store.open(jobId);
    }
    /**
     * Routes one chunk of a job's output into the store and evaluates the new
     * complete lines against the job's active watches. Throws when the store
     * rejects the push (unknown or already-closed job).
     */
    push(jobId, stream, text) {
        const records = [...this.#watches.values()].filter((record) => record.watch.jobId === jobId);
        // Preserve any retained backlog written directly to the shared store.
        const matched = new Set(records.filter((record) => this.#evaluateWatch(record)));
        const completed = this.#store.push(jobId, stream, text);
        const read = this.#store.readLines(jobId);
        for (const record of records) {
            if (this.#matchLines(record, completed))
                matched.add(record);
            // Retained lines from this push were just observed. Scanning them on
            // the next push or settlement would duplicate their matches.
            record.nextLine = read?.lines.length ?? 0;
            record.lastDroppedLines = read?.droppedLines ?? 0;
        }
        for (const record of matched)
            this.#reschedule(record);
    }
    /**
     * Registers a watch and returns its watchId. Replays the retained buffer
     * from `fromOffset` immediately; on a job that has already settled, any
     * replay match is flushed synchronously and the watch retires, because no
     * firing may trail a job's completion.
     */
    registerWatch(options) {
        const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
        // 0 = unlimited (default). The previous 1-with-pattern / 5-without-pattern
        // defaults quietly retired long-running watches; consumers wanting a cap
        // pass it explicitly.
        const notifyLimit = options.notifyLimit ?? 0;
        const fromOffset = options.fromOffset ?? 0;
        const stream = options.stream ?? 'both';
        if (!Number.isInteger(idleMs) || idleMs < 0) {
            throw new RangeError('idleMs must be a non-negative integer.');
        }
        if (!Number.isInteger(notifyLimit) || notifyLimit < 0) {
            throw new RangeError('notifyLimit must be a non-negative integer (0 = unlimited).');
        }
        if (!Number.isInteger(fromOffset) || fromOffset < 0) {
            throw new RangeError('fromOffset must be a non-negative integer.');
        }
        const read = this.#store.readLines(options.jobId);
        if (read === undefined) {
            throw new BackgroundShellWatchesError(`No output stream open for job ${options.jobId}.`);
        }
        const watch = {
            watchId: `watch-${++this.#nextWatchId}`,
            jobId: options.jobId,
            pattern: options.pattern,
            stream,
            idleMs,
            notifyLimit,
            fromOffset,
        };
        const record = {
            watch,
            command: options.command,
            nextLine: Math.min(fromOffset, read.lines.length),
            lastDroppedLines: read.droppedLines,
            pending: [],
            pendingBytes: 0,
            pendingTotalLines: 0,
            // The first line matched (now or during replay) belongs to seq 1.
            pendingSeqStart: 1,
            firedCount: 0,
            timer: null,
        };
        this.#watches.set(watch.watchId, record);
        this.#evaluateWatch(record);
        if (read.closed) {
            // A settled job has no future output and no future quiet to wait for:
            // flush any replay match synchronously, then retire on terminal status.
            if (record.timer !== null) {
                this.#scheduler.cancel(record.timer);
                record.timer = null;
            }
            if (record.pending.length > 0 && options.deferInitialDelivery) {
                record.timer = this.#scheduler.schedule(() => {
                    record.timer = null;
                    if (record.pending.length > 0)
                        this.#fire(record);
                    this.#retire(watch.watchId);
                }, 0);
            }
            else {
                if (record.pending.length > 0)
                    this.#fire(record);
                this.#retire(watch.watchId);
            }
        }
        else if (record.pending.length > 0) {
            this.#reschedule(record);
        }
        return watch.watchId;
    }
    /** Retires a watch by id. Returns false when no such watch exists. */
    cancelWatch(watchId) {
        if (!this.#watches.has(watchId))
            return false;
        this.#retire(watchId);
        return true;
    }
    /**
     * Terminal settlement of a job. Closes the store stream (flushing each
     * pending partial line), evaluates those final lines, then flushes every
     * matched-but-undelivered firing synchronously and retires the job's
     * watches. After this returns, no timer for the job can ever fire again, so
     * the caller may emit the completion notification.
     */
    settleJob(jobId) {
        this.#store.close(jobId);
        for (const record of [...this.#watches.values()]) {
            if (record.watch.jobId !== jobId)
                continue;
            this.#evaluateWatch(record);
            // The job is ending: there is no more quiet to wait for, so cancel the
            // debounce and deliver everything matched so far.
            if (record.timer !== null) {
                this.#scheduler.cancel(record.timer);
                record.timer = null;
            }
            if (record.pending.length > 0)
                this.#fire(record);
            this.#retire(record.watch.watchId);
        }
    }
    /**
     * Evaluates newly retained complete lines against one watch, honouring the
     * stream filter and pattern. Eviction removes whole lines from the head, so
     * `nextLine` is shifted by the number of lines dropped since the last
     * evaluation. Returns true when new lines matched.
     */
    #evaluateWatch(record) {
        const read = this.#store.readLines(record.watch.jobId);
        if (read === undefined)
            return false;
        const evicted = Math.max(0, read.droppedLines - record.lastDroppedLines);
        record.nextLine = Math.max(0, record.nextLine - evicted);
        record.lastDroppedLines = read.droppedLines;
        const matched = this.#matchLines(record, read.lines.slice(record.nextLine));
        record.nextLine = read.lines.length;
        return matched;
    }
    #matchLines(record, lines) {
        const { watch } = record;
        let matched = false;
        for (const line of lines) {
            if (!streamAllows(watch.stream, line.stream))
                continue;
            if (watch.pattern !== undefined && !patternMatches(watch.pattern, line.text))
                continue;
            matched = true;
            if (record.pending.length === 0) {
                // First line of a fresh batch: anchor its seq so the firing can
                // publish the range this batch will cover. After delivery, the next
                // line is seq (firedCount + 1) again.
                record.pendingSeqStart = record.firedCount + 1;
            }
            record.pending.push(line.text);
            record.pendingBytes += line.text.length;
            record.pendingTotalLines += 1;
            // The cap evicts from the head to keep `matchedLines` bounded; the
            // dropped lines were part of the same firing anyway, so the seq range
            // this batch will cover is unchanged.
            while (record.pendingBytes > MAX_MATCHED_TEXT && record.pending.length > 1) {
                const dropped = record.pending.shift();
                if (dropped !== undefined)
                    record.pendingBytes -= dropped.length;
            }
        }
        return matched;
    }
    /** (Re)starts the idle debounce window for a watch that just matched. */
    #reschedule(record) {
        if (record.timer !== null)
            this.#scheduler.cancel(record.timer);
        record.timer = this.#scheduler.schedule(() => this.#deliver(record.watch.watchId), record.watch.idleMs);
    }
    /** The debounce timer fired: deliver one firing carrying all pending matches. */
    #deliver(watchId) {
        const record = this.#watches.get(watchId);
        if (record === undefined || record.timer === null)
            return;
        record.timer = null;
        if (record.pending.length === 0)
            return;
        this.#fire(record);
    }
    /**
     * Delivers one firing (the next `seq`), then retires the watch if it has
     * reached `notifyLimit` (and `notifyLimit` is not 0, the unlimited sentinel)
     * — delivering the last firing is what retires it.
     */
    #fire(record) {
        const { watch } = record;
        record.firedCount += 1;
        const seq = record.firedCount;
        const firing = {
            jobId: watch.jobId,
            watchId: watch.watchId,
            seq,
            matchedLines: joinPending(record.pending),
            coalescedCount: record.pendingTotalLines,
            seqRange: { first: record.pendingSeqStart, last: seq },
            droppedBytes: this.#store.readLines(watch.jobId)?.droppedBytes ?? 0,
            ...(record.command === undefined ? {} : { command: record.command }),
        };
        record.pending = [];
        record.pendingBytes = 0;
        record.pendingTotalLines = 0;
        record.pendingSeqStart = seq + 1;
        this.#emit(firing);
        if (watch.notifyLimit !== 0 && record.firedCount >= watch.notifyLimit)
            this.#retire(watch.watchId);
    }
    #retire(watchId) {
        const record = this.#watches.get(watchId);
        if (record === undefined)
            return;
        if (record.timer !== null) {
            this.#scheduler.cancel(record.timer);
            record.timer = null;
        }
        this.#watches.delete(watchId);
    }
    #emit(firing) {
        try {
            this.#onFiring?.(firing);
        }
        catch {
            // Subscribers are observational: a failing subscriber must not break the
            // flush-before-completion ordering for the remaining watches.
        }
    }
}
function streamAllows(watchStream, lineStream) {
    return watchStream === 'both' || watchStream === lineStream;
}
function patternMatches(pattern, text) {
    // A /g or /y pattern is stateful; restore its position so watch matching
    // never mutates caller-visible regex state.
    const lastIndex = pattern.lastIndex;
    pattern.lastIndex = 0;
    const matched = pattern.test(text);
    pattern.lastIndex = lastIndex;
    return matched;
}
function joinPending(pending) {
    const joined = pending.join('\n');
    return joined.length > MAX_MATCHED_TEXT ? joined.slice(joined.length - MAX_MATCHED_TEXT) : joined;
}
//# sourceMappingURL=background-shell-watches.js.map