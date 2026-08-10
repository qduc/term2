/**
 * Session-owned retention of per-job background shell output.
 *
 * One ring buffer per job holds tagged, complete-line records in arrival order
 * — chronological, unlike the settled result, which keeps stdout and stderr
 * separate. The buffer is capped by both bytes and lines; eviction always drops
 * from the head (the oldest output) and is surfaced through
 * `droppedBytes`/`droppedLines` on every read, so a consumer is never shown a
 * silently incomplete tail.
 *
 * Line assembly is this module's job, not the consumer's: chunks arrive on
 * arbitrary byte boundaries, so each stream's pending partial line is held out
 * of the buffer until it terminates (or until {@link BackgroundShellOutputStore.close}
 * flushes it at EOF). Matching sees only complete lines, so a pattern can never
 * span a chunk split or match half a line.
 *
 * Pure unit module: no processes, no timers, no shell-tool coupling. The shell
 * tool opens a job's stream when the job launches, pushes chunks as they
 * arrive, and closes it in the registry's `onSettled` callback.
 */
export type BackgroundShellOutputStream = 'stdout' | 'stderr';

export interface BackgroundShellOutputLine {
  stream: BackgroundShellOutputStream;
  /** A complete line of output, without its trailing newline. '\r' is preserved. */
  text: string;
}

export interface BackgroundShellOutputRead {
  /** Complete lines in arrival order. The pending partial line is excluded until close. */
  lines: readonly BackgroundShellOutputLine[];
  /** Bytes dropped from the head of the retained stream since this job opened. */
  droppedBytes: number;
  /** Complete lines dropped from the head since this job opened. */
  droppedLines: number;
  /** True once `close` flushed the stream; no more lines can ever arrive. */
  closed: boolean;
}

export interface BackgroundShellOutputTailRead {
  /**
   * Newest retained bytes in arrival order: complete lines joined by '\n',
   * with each stream's pending partial line in its chronological position. An
   * EOF-flushed final line is not given a newline it never had.
   */
  text: string;
  /** Store evictions since this job opened, not bytes cut by the read window. */
  droppedBytes: number;
  droppedLines: number;
  closed: boolean;
}

export interface BackgroundShellOutputStoreOptions {
  /**
   * Max retained bytes per job, including pending partial-line text. Line
   * terminators are not counted. Default 256 KB.
   */
  maxBytes?: number;
  /** Max retained complete lines per job. Default 2000. */
  maxLines?: number;
  /** Max settled jobs whose buffers survive for post-hoc reads. Default 20. */
  maxRetainedJobs?: number;
}

export class BackgroundShellOutputStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundShellOutputStoreError';
  }
}

interface JobOutputRecord extends BackgroundShellOutputLine {
  /** Position of this line's last byte in the job's arrival order; orders the tail read. */
  seq: number;
  /** True when the line ended in '\n'; false for a partial line flushed at EOF. */
  terminated: boolean;
}

interface JobOutput {
  records: JobOutputRecord[];
  remainder: Partial<Record<BackgroundShellOutputStream, string>>;
  /** Arrival position of each pending remainder's last byte. */
  remainderSeq: Partial<Record<BackgroundShellOutputStream, number>>;
  /** Streams with pending partial-line text, oldest first (for byte-cap trimming). */
  remainderOrder: BackgroundShellOutputStream[];
  droppedBytes: number;
  droppedLines: number;
  closed: boolean;
  nextSeq: number;
}

export class BackgroundShellOutputStore {
  readonly #jobs = new Map<string, JobOutput>();
  /** Settled job ids in close order; retention evicts from the front. */
  readonly #settled: string[] = [];
  readonly #maxBytes: number;
  readonly #maxLines: number;
  readonly #maxRetainedJobs: number;

  constructor(options: BackgroundShellOutputStoreOptions = {}) {
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
  open(jobId: string): void {
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
   * per stream. Throws if the job is unknown or already closed.
   */
  push(jobId: string, stream: BackgroundShellOutputStream, text: string): void {
    const job = this.#jobs.get(jobId);
    if (!job) throw new BackgroundShellOutputStoreError(`No output stream open for job ${jobId}.`);
    if (job.closed) throw new BackgroundShellOutputStoreError(`Output stream for job ${jobId} is already closed.`);
    if (text.length === 0) return;

    let pending = (job.remainder[stream] ?? '') + text;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      job.records.push({
        stream,
        text: pending.slice(0, newline),
        seq: job.nextSeq++,
        terminated: true,
      });
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
    job.remainder[stream] = pending;
    if (pending.length > 0) {
      job.remainderSeq[stream] = job.nextSeq++;
      if (!job.remainderOrder.includes(stream)) job.remainderOrder.push(stream);
    } else {
      delete job.remainder[stream];
      delete job.remainderSeq[stream];
      const index = job.remainderOrder.indexOf(stream);
      if (index !== -1) job.remainderOrder.splice(index, 1);
    }
    this.#evictToFit(job);
  }

  /**
   * Ends a job's output stream: flushes each pending partial line as a final
   * record and marks the job settled, subject to retention eviction. Returns
   * true if this call settled the stream; a second close is a no-op returning
   * false. Throws if the job was never opened.
   */
  close(jobId: string): boolean {
    const job = this.#jobs.get(jobId);
    if (!job) throw new BackgroundShellOutputStoreError(`No output stream open for job ${jobId}.`);
    if (job.closed) return false;

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
      if (evicted) this.#jobs.delete(evicted);
    }
    return true;
  }

  /** Reads the retained complete lines of a job. Returns undefined for unknown jobs. */
  readLines(jobId: string): BackgroundShellOutputRead | undefined {
    const job = this.#jobs.get(jobId);
    if (!job) return undefined;
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
  readTail(jobId: string, maxBytes: number = this.#maxBytes): BackgroundShellOutputTailRead | undefined {
    if (!Number.isInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('maxBytes must be a non-negative integer.');
    }
    const job = this.#jobs.get(jobId);
    if (!job) return undefined;

    const segments: Array<{ seq: number; text: string; newline: boolean }> = [];
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
    for (const segment of segments) text += segment.newline ? `${segment.text}\n` : segment.text;
    if (text.length > maxBytes) text = text.slice(text.length - maxBytes);
    return { text, droppedBytes: job.droppedBytes, droppedLines: job.droppedLines, closed: job.closed };
  }

  /** Retained bytes per job, including pending partial-line text. */
  #retainedBytes(job: JobOutput): number {
    let bytes = 0;
    for (const record of job.records) bytes += record.text.length;
    for (const stream of job.remainderOrder) bytes += job.remainder[stream]?.length ?? 0;
    return bytes;
  }

  /**
   * Drops from the head of the retained stream until both caps hold. Whole
   * lines go first (they are the oldest content); a byte overflow that whole
   * lines cannot fix is a single pending partial line longer than the cap, in
   * which case its oldest bytes are dropped and its newest tail is kept. Every
   * drop is accounted for in `droppedBytes`/`droppedLines`.
   */
  #evictToFit(job: JobOutput): void {
    while (
      job.records.length > 0 &&
      (this.#retainedBytes(job) > this.#maxBytes || job.records.length > this.#maxLines)
    ) {
      const head = job.records.shift();
      if (head) {
        job.droppedBytes += head.text.length;
        job.droppedLines += 1;
      }
    }

    let overflow = this.#retainedBytes(job) - this.#maxBytes;
    for (const stream of [...job.remainderOrder]) {
      if (overflow <= 0) break;
      const text = job.remainder[stream];
      if (text === undefined || text.length === 0) continue;
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
        if (index !== -1) job.remainderOrder.splice(index, 1);
      }
    }
  }
}
