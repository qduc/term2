import { describe, expect, it } from 'vitest';
import { BackgroundShellOutputStore } from './background-shell-output-store.js';
import {
  BackgroundShellWatches,
  BackgroundShellWatchesError,
  type BackgroundShellWatchScheduler,
  type ShellOutputFiring,
} from './background-shell-watches.js';

/**
 * Deterministic in-test timer implementation. The watches module only ever
 * touches the injected scheduler, so no real timer can fire in these tests.
 */
class FakeScheduler implements BackgroundShellWatchScheduler {
  #now = 0;
  #nextId = 1;
  readonly #due = new Map<number, { at: number; callback: () => void }>();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#due.set(id, { at: this.#now + delayMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.#due.delete(handle as number);
  }

  /** Advances the clock and runs every timer whose due time has passed. */
  advance(ms: number): void {
    this.#now += ms;
    for (;;) {
      const due = [...this.#due.entries()]
        .filter(([, entry]) => entry.at <= this.#now)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) return;
      for (const [id, entry] of due) {
        this.#due.delete(id);
        entry.callback();
      }
    }
  }
}

function setup(store: BackgroundShellOutputStore = new BackgroundShellOutputStore()) {
  const scheduler = new FakeScheduler();
  const firings: ShellOutputFiring[] = [];
  const watches = new BackgroundShellWatches({
    store,
    scheduler,
    onFiring: (firing) => firings.push(firing),
  });
  return { store, scheduler, watches, firings };
}
describe('BackgroundShellWatches', () => {
  it('re-routes firings through a new onFiring subscriber after setOnFiring', () => {
    const { store, scheduler, watches } = setup();
    store.open('job-1');
    const later: ShellOutputFiring[] = [];
    watches.setOnFiring((firing) => later.push(firing));

    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /listening on \d+/ });
    watches.push('job-1', 'stdout', 'server listening on 3000\n');
    scheduler.advance(1500);

    expect(later).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'server listening on 3000' })]);
    watches.setOnFiring(undefined);
    watches.push('job-1', 'stdout', 'again listening on 3001\n');
    scheduler.advance(1500);
    expect(later).toHaveLength(1);
  });

  it('fires once with the matched line after idleMs of quiet', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({
      jobId: 'job-1',
      pattern: /listening on \d+/,
      command: 'npm run dev',
    });

    watches.push('job-1', 'stdout', 'compiling...\n');
    watches.push('job-1', 'stdout', 'server listening on 3000\n');
    expect(firings).toEqual([]);

    scheduler.advance(1500);

    expect(firings).toEqual([
      {
        jobId: 'job-1',
        watchId,
        seq: 1,
        matchedLines: 'server listening on 3000',
        coalescedCount: 1,
        seqRange: { first: 1, last: 1 },
        droppedBytes: 0,
        command: 'npm run dev',
      },
    ]);
  });

  it('replays lines printed before registration from the default fromOffset 0', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    store.push('job-1', 'stdout', 'starting\n');
    store.push('job-1', 'stdout', 'listening on 8080\n');

    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /listening/ });

    scheduler.advance(1500);

    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'listening on 8080' })]);
  });

  it('skips retained lines before a non-zero fromOffset but still evaluates later ones', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    store.push('job-1', 'stdout', 'line one\n');
    store.push('job-1', 'stdout', 'line two\n');
    store.push('job-1', 'stdout', 'line three\n');

    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /line/, fromOffset: 2, notifyLimit: 5 });

    scheduler.advance(1500);
    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'line three' })]);

    watches.push('job-1', 'stdout', 'line four\n');
    scheduler.advance(1500);
    expect(firings).toEqual([
      expect.objectContaining({ watchId, seq: 1, matchedLines: 'line three' }),
      expect.objectContaining({ watchId, seq: 2, matchedLines: 'line four' }),
    ]);
  });

  it('coalesces a burst of matches into one firing carrying the whole burst', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /error/, idleMs: 1500 });
    for (let i = 1; i <= 200; i++) {
      watches.push('job-1', 'stderr', `error in build ${i}\n`);
    }

    scheduler.advance(1500);

    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({ watchId, seq: 1, coalescedCount: 200, seqRange: { first: 1, last: 1 } });
    expect(firings[0].matchedLines.split('\n')).toHaveLength(200);
  });

  it('resets the idle window on each new match (debounce)', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /error/ });

    watches.push('job-1', 'stderr', 'error a\n');
    scheduler.advance(1000);
    watches.push('job-1', 'stderr', 'error b\n');
    scheduler.advance(1000);
    expect(firings).toEqual([]); // still inside the window opened by the second match

    scheduler.advance(500);

    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'error a\nerror b' })]);
  });

  it('retires after notifyLimit firings, delivering the last one', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /tick/, notifyLimit: 2 });

    watches.push('job-1', 'stdout', 'tick 1\n');
    scheduler.advance(1500);
    watches.push('job-1', 'stdout', 'tick 2\n');
    scheduler.advance(1500);
    watches.push('job-1', 'stdout', 'tick 3\n');
    scheduler.advance(1500);

    expect(firings.map((firing) => firing.seq)).toEqual([1, 2]);
  });

  it('defaults notifyLimit to 0 (unlimited) regardless of whether a pattern is set', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');

    const patterned = watches.registerWatch({ jobId: 'job-1', pattern: /hit/ });
    for (let i = 0; i < 6; i++) {
      watches.push('job-1', 'stdout', 'hit\n');
      scheduler.advance(1500);
    }
    expect(firings.filter((firing) => firing.watchId === patterned)).toHaveLength(6);

    const anyLine = watches.registerWatch({ jobId: 'job-1' });
    for (let i = 0; i < 6; i++) {
      watches.push('job-1', 'stdout', `line ${i}\n`);
      scheduler.advance(1500);
    }
    expect(firings.filter((firing) => firing.watchId === anyLine)).toHaveLength(6);
  });

  it('treats notifyLimit: 0 as unlimited: the watch keeps firing past any prior cap', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /tick/, notifyLimit: 0 });

    for (let i = 1; i <= 50; i++) {
      watches.push('job-1', 'stdout', `tick ${i}\n`);
      scheduler.advance(1500);
    }

    expect(firings).toHaveLength(50);
    expect(firings.at(-1)).toMatchObject({ watchId, seq: 50 });
  });

  it('reports coalescedCount including lines evicted from the matched text by the byte cap', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /x+/ });

    // A burst whose total bytes exceed MAX_MATCHED_TEXT (4 KB) by an order of
    // magnitude; only the newest 4 KB of joined text should be retained.
    const line = `${'x'.repeat(50)}\n`;
    for (let i = 0; i < 200; i++) watches.push('job-1', 'stdout', line);

    scheduler.advance(1500);

    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({ watchId, seq: 1, coalescedCount: 200, seqRange: { first: 1, last: 1 } });
    expect(firings[0].matchedLines.length).toBeLessThanOrEqual(4096);
  });

  it('flushes undelivered matches during settleJob, before it returns, and never after terminal', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /ready/ });

    watches.push('job-1', 'stdout', 'ready\n');
    expect(firings).toEqual([]); // the debounce window is still open

    watches.settleJob('job-1');

    // The flush completed synchronously: the caller can emit the job's
    // completion notification right after this call and be certain no monitor
    // firing will follow it.
    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'ready' })]);
    expect(store.readLines('job-1')).toMatchObject({ closed: true });

    scheduler.advance(60_000);
    expect(firings).toHaveLength(1); // nothing may arrive after terminal

    expect(() => watches.push('job-1', 'stdout', 'late\n')).toThrow();
  });

  it('matches a close-flushed partial line and flushes it before completion', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /listening on \d+/ });

    watches.push('job-1', 'stdout', 'listening on 4000'); // no trailing newline
    scheduler.advance(60_000);
    expect(firings).toEqual([]); // a half line never matches

    watches.settleJob('job-1');

    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'listening on 4000' })]);
  });

  it('retires the job watches on settlement even when nothing matched', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /never/ });

    watches.push('job-1', 'stdout', 'quiet\n');
    watches.settleJob('job-1');

    expect(firings).toEqual([]);
    scheduler.advance(60_000);
    expect(firings).toEqual([]);
    expect(watches.cancelWatch(watchId)).toBe(false); // already retired
  });

  it('gives the terminal flush the next seq after earlier firings', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /warn/, notifyLimit: 5 });

    watches.push('job-1', 'stdout', 'warn one\n');
    scheduler.advance(1500); // seq 1
    watches.push('job-1', 'stdout', 'warn two\n'); // pending, window open
    watches.settleJob('job-1'); // flush: seq 2, then retire

    expect(firings.map((firing) => firing.seq)).toEqual([1, 2]);
    expect(firings[1].matchedLines).toBe('warn two');
  });

  it('registers a watch on an already-settled job by flushing its replay synchronously', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    store.push('job-1', 'stdout', 'done at last\n');
    watches.settleJob('job-1');

    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /done/ });

    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'done at last' })]);
    scheduler.advance(60_000);
    expect(firings).toHaveLength(1);
  });

  it('cancelWatch retires the watch and prevents further firings', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /hi/ });

    expect(watches.cancelWatch(watchId)).toBe(true);
    expect(watches.cancelWatch(watchId)).toBe(false);
    expect(watches.cancelWatch('watch-unknown')).toBe(false);

    watches.push('job-1', 'stdout', 'hi\n');
    scheduler.advance(60_000);
    expect(firings).toEqual([]);
  });

  it('filters by stream: a stdout-only watch ignores stderr and vice versa', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const stdoutOnly = watches.registerWatch({ jobId: 'job-1', pattern: /ping/, stream: 'stdout' });
    const stderrOnly = watches.registerWatch({ jobId: 'job-1', pattern: /ping/, stream: 'stderr' });

    watches.push('job-1', 'stderr', 'ping\n');
    scheduler.advance(1500);
    expect(firings.filter((firing) => firing.watchId === stdoutOnly)).toEqual([]);
    expect(firings.filter((firing) => firing.watchId === stderrOnly)).toHaveLength(1);

    watches.push('job-1', 'stdout', 'ping\n');
    scheduler.advance(1500);
    expect(firings.filter((firing) => firing.watchId === stderrOnly)).toHaveLength(1); // stdout never reaches the stderr watch
    expect(firings.filter((firing) => firing.watchId === stdoutOnly)).toHaveLength(1);
  });

  it('a both-stream watch fires on either stream, coalescing one burst across both', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /ping/, stream: 'both', notifyLimit: 2 });

    watches.push('job-1', 'stderr', 'ping stderr\n');
    watches.push('job-1', 'stdout', 'ping stdout\n');
    scheduler.advance(1500);

    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'ping stderr\nping stdout' })]);
  });

  it('applies pattern semantics: a match fires, a non-match never fires, no pattern fires on any line', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const matching = watches.registerWatch({ jobId: 'job-1', pattern: /error/ });
    const neverMatching = watches.registerWatch({ jobId: 'job-1', pattern: /nope/ });
    const anyLine = watches.registerWatch({ jobId: 'job-1', notifyLimit: 3 });

    watches.push('job-1', 'stderr', 'error: build failed\n');
    watches.push('job-1', 'stdout', 'nothing to see\n');
    scheduler.advance(1500);

    expect(firings.filter((firing) => firing.watchId === matching)).toHaveLength(1);
    expect(firings.filter((firing) => firing.watchId === neverMatching)).toHaveLength(0);
    expect(firings.filter((firing) => firing.watchId === anyLine)).toHaveLength(1);
    expect(firings.find((firing) => firing.watchId === anyLine)?.matchedLines).toBe(
      'error: build failed\nnothing to see',
    );
  });

  it('never matches a half line: partial chunks stay unevaluated until a newline completes them', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /ready/ });

    watches.push('job-1', 'stdout', 'pre');
    watches.push('job-1', 'stdout', 'ready');
    scheduler.advance(1500);
    expect(firings).toEqual([]); // still one unterminated partial line

    watches.push('job-1', 'stdout', '!\n');
    scheduler.advance(1500);

    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'preready!' })]);
  });

  it('caps matchedLines at about 4 KB, keeping the newest text', () => {
    const { store, scheduler, watches, firings } = setup();
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /x+/ });

    watches.push('job-1', 'stdout', `${'x'.repeat(5000)}\n`);
    scheduler.advance(1500);

    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'x'.repeat(4096) })]);
  });

  it('carries the store droppedBytes on the firing when the buffer evicted', () => {
    const { store, scheduler, watches, firings } = setup(new BackgroundShellOutputStore({ maxBytes: 8 }));
    store.open('job-1');
    const watchId = watches.registerWatch({ jobId: 'job-1', pattern: /keep/ });

    watches.push('job-1', 'stdout', 'aaaa\n');
    watches.push('job-1', 'stdout', 'keep me\n'); // evicts 'aaaa' from the head
    scheduler.advance(1500);

    expect(firings).toEqual([expect.objectContaining({ watchId, seq: 1, matchedLines: 'keep me', droppedBytes: 4 })]);
  });

  it('rejects invalid options and unknown jobs', () => {
    const { store, watches } = setup();
    store.open('job-1');

    expect(() => watches.registerWatch({ jobId: 'job-1', idleMs: -1 })).toThrow(RangeError);
    expect(() => watches.registerWatch({ jobId: 'job-1', idleMs: 1.5 })).toThrow(RangeError);
    expect(() => watches.registerWatch({ jobId: 'job-1', notifyLimit: -1 })).toThrow(RangeError);
    expect(() => watches.registerWatch({ jobId: 'job-1', notifyLimit: 1.5 })).toThrow(RangeError);
    // notifyLimit: 0 is the unlimited sentinel, not an error.
    expect(() => watches.registerWatch({ jobId: 'job-1', notifyLimit: 0 })).not.toThrow();
    expect(() => watches.registerWatch({ jobId: 'job-1', fromOffset: -2 })).toThrow(RangeError);
    expect(() => watches.registerWatch({ jobId: 'job-unknown' })).toThrow(BackgroundShellWatchesError);
  });
});
