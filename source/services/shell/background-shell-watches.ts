import type { BackgroundShellOutputStream, BackgroundShellOutputStore } from './background-shell-output-store.js';

/**
 * Watch semantics over a {@link BackgroundShellOutputStore}: attach a watch to
 * a background shell job and be told, without polling, when the job's output
 * says something worth reacting to.
 *
 * A watch fires when a complete line in its selected stream matches its
 * pattern (or, with no pattern, when any new complete line arrives), and only
 * after `idleMs` of quiet — a burst of 200 matching lines produces one firing
 * carrying the burst, not 200 firings. The idle window is quiet *for this
 * watch*: only new matching lines extend it; unrelated output does not delay
 * the firing. Firings are counted per watch (`seq` 1, 2, …); a watch retires
 * when it has fired `notifyLimit` times, when its job settles, or when
 * cancelled by id.
 *
 * Watches replay the job's retained buffer from `fromOffset` (default 0 = the
 * head of the buffer), which is the whole reason no launch-time monitor
 * parameter exists: registering a watch after the line was already printed
 * still catches it. Matching operates only on complete lines from the store —
 * a pattern can never match a half line or a span across a chunk split; line
 * assembly is the store's job.
 *
 * Ordering rule: {@link BackgroundShellWatches.settleJob} closes the store
 * stream (flushing each stream's pending partial line as a final complete
 * line), evaluates those final lines, then flushes every matched-but-
 * undelivered watch firing synchronously and retires the job's watches — all
 * before the call returns, so the caller can emit the job's completion
 * notification and be certain no monitor firing will follow it.
 *
 * Pure unit module: no processes, no real timers, no shell-tool coupling. The
 * timer scheduler is injected so tests drive time deterministically; the
 * phase-5 shell-tool wiring passes a `setTimeout`-based adapter.
 */
export type ShellOutputWatchStream = BackgroundShellOutputStream | 'both';

/** The immutable specification of one watch, as decided in the plan. */
export interface ShellOutputWatch {
  watchId: string;
  jobId: string;
  /** Absent = any output. */
  pattern?: RegExp;
  stream: ShellOutputWatchStream;
  /** Coalescing window in ms; default 1500. */
  idleMs: number;
  /** Firing budget; default 1 when a pattern is set, 5 otherwise. */
  notifyLimit: number;
  /**
   * Number of retained complete lines to skip from the head of the job's
   * buffer when replaying. Default 0 = the whole retained buffer. Lines
   * evicted before registration are not replayable — their bytes are surfaced
   * through `droppedBytes` instead.
   */
  fromOffset: number;
}

export interface RegisterShellOutputWatchOptions {
  jobId: string;
  pattern?: RegExp;
  stream?: ShellOutputWatchStream;
  idleMs?: number;
  notifyLimit?: number;
  fromOffset?: number;
  /** Passed through to every firing so the consumer can name the job. */
  command?: string;
}

export interface ShellOutputFiring {
  jobId: string;
  watchId: string;
  /** Per-watch firing counter, 1-based. */
  seq: number;
  /**
   * Matched complete lines joined by '\n', capped at about 4 KB keeping the
   * newest text.
   */
  matchedLines: string;
  /** Store evictions since the job opened, from the store read at delivery. */
  droppedBytes: number;
  command?: string;
}

/**
 * The module's only contact with wall-clock time. Injected so tests can drive
 * time deterministically; production wiring passes a `setTimeout`-based
 * adapter.
 */
export interface BackgroundShellWatchScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface BackgroundShellWatchesOptions {
  store: BackgroundShellOutputStore;
  scheduler: BackgroundShellWatchScheduler;
  /** Receives every firing. Subscribers are observational: a throw is swallowed. */
  onFiring?: (firing: ShellOutputFiring) => void;
}

export class BackgroundShellWatchesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundShellWatchesError';
  }
}

interface WatchRecord {
  watch: ShellOutputWatch;
  command: string | undefined;
  /** Index into the store's retained line list where the next evaluation starts. */
  nextLine: number;
  /** Store droppedLines at the last evaluation, used to shift `nextLine` after eviction. */
  lastDroppedLines: number;
  /** Matched, undelivered line texts; kept within {@link MAX_MATCHED_TEXT} (newest wins). */
  pending: string[];
  pendingBytes: number;
  /** Firings delivered so far; the next firing carries seq `firedCount + 1`. */
  firedCount: number;
  /** Scheduled debounce delivery, if any. */
  timer: unknown;
}

const DEFAULT_IDLE_MS = 1500;
/** Cap on `matchedLines` and on retained pending text, ~4 KB. */
const MAX_MATCHED_TEXT = 4096;

export class BackgroundShellWatches {
  readonly #store: BackgroundShellOutputStore;
  readonly #scheduler: BackgroundShellWatchScheduler;
  readonly #onFiring: ((firing: ShellOutputFiring) => void) | undefined;
  readonly #watches = new Map<string, WatchRecord>();
  #nextWatchId = 0;

  constructor(options: BackgroundShellWatchesOptions) {
    this.#store = options.store;
    this.#scheduler = options.scheduler;
    this.#onFiring = options.onFiring;
  }

  /** Begins a job's output stream; delegates to the store. */
  open(jobId: string): void {
    this.#store.open(jobId);
  }

  /**
   * Routes one chunk of a job's output into the store and evaluates the new
   * complete lines against the job's active watches. Throws when the store
   * rejects the push (unknown or already-closed job).
   */
  push(jobId: string, stream: BackgroundShellOutputStream, text: string): void {
    this.#store.push(jobId, stream, text);
    for (const record of this.#watches.values()) {
      if (record.watch.jobId !== jobId) continue;
      if (this.#evaluateWatch(record)) this.#reschedule(record);
    }
  }

  /**
   * Registers a watch and returns its watchId. Replays the retained buffer
   * from `fromOffset` immediately; on a job that has already settled, any
   * replay match is flushed synchronously and the watch retires, because no
   * firing may trail a job's completion.
   */
  registerWatch(options: RegisterShellOutputWatchOptions): string {
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    const notifyLimit = options.notifyLimit ?? (options.pattern === undefined ? 5 : 1);
    const fromOffset = options.fromOffset ?? 0;
    const stream = options.stream ?? 'both';
    if (!Number.isInteger(idleMs) || idleMs < 0) {
      throw new RangeError('idleMs must be a non-negative integer.');
    }
    if (!Number.isInteger(notifyLimit) || notifyLimit < 1) {
      throw new RangeError('notifyLimit must be a positive integer.');
    }
    if (!Number.isInteger(fromOffset) || fromOffset < 0) {
      throw new RangeError('fromOffset must be a non-negative integer.');
    }

    const read = this.#store.readLines(options.jobId);
    if (read === undefined) {
      throw new BackgroundShellWatchesError(`No output stream open for job ${options.jobId}.`);
    }

    const watch: ShellOutputWatch = {
      watchId: `watch-${++this.#nextWatchId}`,
      jobId: options.jobId,
      pattern: options.pattern,
      stream,
      idleMs,
      notifyLimit,
      fromOffset,
    };
    const record: WatchRecord = {
      watch,
      command: options.command,
      nextLine: Math.min(fromOffset, read.lines.length),
      lastDroppedLines: read.droppedLines,
      pending: [],
      pendingBytes: 0,
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
      if (record.pending.length > 0) this.#fire(record);
      this.#retire(watch.watchId);
    } else if (record.pending.length > 0) {
      this.#reschedule(record);
    }
    return watch.watchId;
  }

  /** Retires a watch by id. Returns false when no such watch exists. */
  cancelWatch(watchId: string): boolean {
    if (!this.#watches.has(watchId)) return false;
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
  settleJob(jobId: string): void {
    this.#store.close(jobId);

    for (const record of [...this.#watches.values()]) {
      if (record.watch.jobId !== jobId) continue;
      this.#evaluateWatch(record);
      // The job is ending: there is no more quiet to wait for, so cancel the
      // debounce and deliver everything matched so far.
      if (record.timer !== null) {
        this.#scheduler.cancel(record.timer);
        record.timer = null;
      }
      if (record.pending.length > 0) this.#fire(record);
      this.#retire(record.watch.watchId);
    }
  }

  /**
   * Evaluates newly retained complete lines against one watch, honouring the
   * stream filter and pattern. Eviction removes whole lines from the head, so
   * `nextLine` is shifted by the number of lines dropped since the last
   * evaluation. Returns true when new lines matched.
   */
  #evaluateWatch(record: WatchRecord): boolean {
    const read = this.#store.readLines(record.watch.jobId);
    if (read === undefined) return false;

    const evicted = Math.max(0, read.droppedLines - record.lastDroppedLines);
    record.nextLine = Math.max(0, record.nextLine - evicted);
    record.lastDroppedLines = read.droppedLines;

    const { watch } = record;
    let matched = false;
    for (let i = record.nextLine; i < read.lines.length; i++) {
      const line = read.lines[i];
      if (!streamAllows(watch.stream, line.stream)) continue;
      if (watch.pattern !== undefined && !patternMatches(watch.pattern, line.text)) continue;
      matched = true;
      record.pending.push(line.text);
      record.pendingBytes += line.text.length;
      while (record.pendingBytes > MAX_MATCHED_TEXT && record.pending.length > 1) {
        const dropped = record.pending.shift();
        if (dropped !== undefined) record.pendingBytes -= dropped.length;
      }
    }
    record.nextLine = read.lines.length;
    return matched;
  }

  /** (Re)starts the idle debounce window for a watch that just matched. */
  #reschedule(record: WatchRecord): void {
    if (record.timer !== null) this.#scheduler.cancel(record.timer);
    record.timer = this.#scheduler.schedule(() => this.#deliver(record.watch.watchId), record.watch.idleMs);
  }

  /** The debounce timer fired: deliver one firing carrying all pending matches. */
  #deliver(watchId: string): void {
    const record = this.#watches.get(watchId);
    if (record === undefined || record.timer === null) return;
    record.timer = null;
    if (record.pending.length === 0) return;
    this.#fire(record);
  }

  /**
   * Delivers one firing (the next `seq`), then retires the watch if it has
   * reached `notifyLimit` — delivering the last firing is what retires it.
   */
  #fire(record: WatchRecord): void {
    const { watch } = record;
    record.firedCount += 1;
    const firing: ShellOutputFiring = {
      jobId: watch.jobId,
      watchId: watch.watchId,
      seq: record.firedCount,
      matchedLines: joinPending(record.pending),
      droppedBytes: this.#store.readLines(watch.jobId)?.droppedBytes ?? 0,
      ...(record.command === undefined ? {} : { command: record.command }),
    };
    record.pending = [];
    record.pendingBytes = 0;
    this.#emit(firing);
    if (record.firedCount >= watch.notifyLimit) this.#retire(watch.watchId);
  }

  #retire(watchId: string): void {
    const record = this.#watches.get(watchId);
    if (record === undefined) return;
    if (record.timer !== null) {
      this.#scheduler.cancel(record.timer);
      record.timer = null;
    }
    this.#watches.delete(watchId);
  }

  #emit(firing: ShellOutputFiring): void {
    try {
      this.#onFiring?.(firing);
    } catch {
      // Subscribers are observational: a failing subscriber must not break the
      // flush-before-completion ordering for the remaining watches.
    }
  }
}

function streamAllows(watchStream: ShellOutputWatchStream, lineStream: BackgroundShellOutputStream): boolean {
  return watchStream === 'both' || watchStream === lineStream;
}

function patternMatches(pattern: RegExp, text: string): boolean {
  // A /g or /y pattern is stateful; restore its position so watch matching
  // never mutates caller-visible regex state.
  const lastIndex = pattern.lastIndex;
  pattern.lastIndex = 0;
  const matched = pattern.test(text);
  pattern.lastIndex = lastIndex;
  return matched;
}

function joinPending(pending: readonly string[]): string {
  const joined = pending.join('\n');
  return joined.length > MAX_MATCHED_TEXT ? joined.slice(joined.length - MAX_MATCHED_TEXT) : joined;
}
