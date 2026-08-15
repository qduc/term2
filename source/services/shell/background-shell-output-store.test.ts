import { describe, expect, it } from 'vitest';
import { BackgroundShellOutputStore, BackgroundShellOutputStoreError } from './background-shell-output-store.js';

describe('BackgroundShellOutputStore', () => {
  it('retains stdout and stderr lines in arrival order, interleaved', () => {
    const store = new BackgroundShellOutputStore();
    store.open('job-1');
    store.push('job-1', 'stdout', 'a\n');
    store.push('job-1', 'stderr', 'b\n');
    store.push('job-1', 'stdout', 'c\n');

    expect(store.readLines('job-1')).toEqual({
      lines: [
        { stream: 'stdout', text: 'a' },
        { stream: 'stderr', text: 'b' },
        { stream: 'stdout', text: 'c' },
      ],
      droppedBytes: 0,
      droppedLines: 0,
      closed: false,
    });
  });

  it('assembles a line across a chunk split and exposes it only once complete', () => {
    const store = new BackgroundShellOutputStore();
    store.open('job-1');
    store.push('job-1', 'stdout', 'hel');

    expect(store.readLines('job-1')?.lines).toEqual([]);

    store.push('job-1', 'stdout', 'lo\n');

    expect(store.readLines('job-1')?.lines).toEqual([{ stream: 'stdout', text: 'hello' }]);
  });

  it('keeps each stream partial line separate and includes it in the tail read', () => {
    const store = new BackgroundShellOutputStore();
    store.open('job-1');
    store.push('job-1', 'stdout', 'hel');
    store.push('job-1', 'stderr', 'lo\n');

    // stdout's 'hel' is still pending: only stderr's completed line is exposed,
    // and the two streams never merge into one 'hello' line.
    expect(store.readLines('job-1')?.lines).toEqual([{ stream: 'stderr', text: 'lo' }]);
    // The tail is the byte timeline: 'hel' arrived before 'lo\n'.
    expect(store.readTail('job-1')?.text).toBe('hello\n');

    store.close('job-1');
    expect(store.readLines('job-1')?.lines).toEqual([
      { stream: 'stderr', text: 'lo' },
      { stream: 'stdout', text: 'hel' },
    ]);
    // Closing does not change the retained byte timeline.
    expect(store.readTail('job-1')?.text).toBe('hello\n');
  });

  it('flushes the pending partial line when the stream closes', () => {
    const store = new BackgroundShellOutputStore();
    store.open('job-1');
    store.push('job-1', 'stdout', 'abc');

    expect(store.readLines('job-1')).toMatchObject({ lines: [], closed: false });
    expect(store.close('job-1')).toBe(true);

    expect(store.readLines('job-1')).toEqual({
      lines: [{ stream: 'stdout', text: 'abc' }],
      droppedBytes: 0,
      droppedLines: 0,
      closed: true,
    });
    expect(store.readTail('job-1')?.text).toBe('abc');
  });

  it('evicts whole lines from the head to hold the byte cap and reports droppedBytes', () => {
    const store = new BackgroundShellOutputStore({ maxBytes: 16 });
    store.open('job-1');
    store.push('job-1', 'stdout', 'aaaa\n');
    store.push('job-1', 'stdout', 'bbbbbbbb\n');
    store.push('job-1', 'stdout', 'cccc\n');

    expect(store.readLines('job-1')?.lines.map((line) => line.text)).toEqual(['aaaa', 'bbbbbbbb', 'cccc']);

    store.push('job-1', 'stdout', 'dd\n');

    expect(store.readLines('job-1')).toEqual({
      lines: [
        { stream: 'stdout', text: 'bbbbbbbb' },
        { stream: 'stdout', text: 'cccc' },
        { stream: 'stdout', text: 'dd' },
      ],
      droppedBytes: 4,
      droppedLines: 1,
      closed: false,
    });
  });

  it('evicts from the head to hold the line cap and reports droppedLines', () => {
    const store = new BackgroundShellOutputStore({ maxLines: 3 });
    store.open('job-1');
    for (const text of ['a\n', 'b\n', 'c\n', 'd\n', 'e\n']) {
      store.push('job-1', 'stdout', text);
    }

    expect(store.readLines('job-1')).toEqual({
      lines: [
        { stream: 'stdout', text: 'c' },
        { stream: 'stdout', text: 'd' },
        { stream: 'stdout', text: 'e' },
      ],
      droppedBytes: 2,
      droppedLines: 2,
      closed: false,
    });
  });

  it('bounds a single unterminated chunk to the byte cap, keeping the newest bytes', () => {
    const store = new BackgroundShellOutputStore({ maxBytes: 16 });
    store.open('job-1');
    store.push('job-1', 'stdout', 'x'.repeat(100));

    expect(store.readLines('job-1')).toEqual({ lines: [], droppedBytes: 84, droppedLines: 0, closed: false });
    expect(store.readTail('job-1')?.text).toBe('x'.repeat(16));
  });

  it('retains an unterminated chunk one byte below the byte cap without eviction', () => {
    const store = new BackgroundShellOutputStore({ maxBytes: 16 });
    store.open('job-1');
    store.push('job-1', 'stdout', 'x'.repeat(15));

    expect(store.readLines('job-1')).toEqual({ lines: [], droppedBytes: 0, droppedLines: 0, closed: false });
    expect(store.readTail('job-1')).toEqual({ text: 'x'.repeat(15), droppedBytes: 0, droppedLines: 0, closed: false });
  });

  it('surfaces the same dropped counters through every read', () => {
    const store = new BackgroundShellOutputStore({ maxBytes: 8 });
    store.open('job-1');
    store.push('job-1', 'stdout', 'aaaa\n');
    store.push('job-1', 'stdout', 'bbbb\n');
    expect(store.readLines('job-1')?.droppedBytes).toBe(0);

    store.push('job-1', 'stdout', 'cc\n');

    const read = store.readLines('job-1');
    expect(read?.droppedBytes).toBe(4);
    expect(read?.droppedLines).toBe(1);
    expect(read?.lines.map((line) => line.text)).toEqual(['bbbb', 'cc']);
    expect(store.readTail('job-1')).toMatchObject({ droppedBytes: 4, droppedLines: 1 });
    expect(store.readTail('job-1')?.text).toBe('bbbb\ncc\n');
  });

  it('cuts the tail read to the requested window', () => {
    const store = new BackgroundShellOutputStore();
    store.open('job-1');
    store.push('job-1', 'stdout', 'alpha\n');
    store.push('job-1', 'stderr', 'beta\n');
    store.push('job-1', 'stdout', 'part');

    expect(store.readTail('job-1')?.text).toBe('alpha\nbeta\npart');
    expect(store.readTail('job-1', 6)?.text).toBe('a\npart');
  });

  it('retains only the newest settled jobs, oldest evicted first', () => {
    const store = new BackgroundShellOutputStore({ maxRetainedJobs: 1 });
    store.open('job-a');
    store.push('job-a', 'stdout', 'a\n');
    store.close('job-a');
    store.open('job-b');
    store.push('job-b', 'stdout', 'b\n');

    // A running job never counts against retention: job-a survives while job-b runs.
    expect(store.readLines('job-a')).toBeDefined();

    store.close('job-b');

    expect(store.readLines('job-a')).toBeUndefined();
    expect(store.readLines('job-b')).toMatchObject({ closed: true });
  });

  it('close is idempotent and flushes each remainder exactly once', () => {
    const store = new BackgroundShellOutputStore();
    store.open('job-1');
    store.push('job-1', 'stdout', 'abc');

    expect(store.close('job-1')).toBe(true);
    expect(store.close('job-1')).toBe(false);

    expect(store.readLines('job-1')?.lines).toEqual([{ stream: 'stdout', text: 'abc' }]);
  });

  it('throws on stream misuse and returns undefined for unknown reads', () => {
    const store = new BackgroundShellOutputStore();
    expect(store.readLines('job-unknown')).toBeUndefined();
    expect(store.readTail('job-unknown')).toBeUndefined();

    store.open('job-1');
    expect(() => store.open('job-1')).toThrow(BackgroundShellOutputStoreError);
    expect(() => store.push('job-unknown', 'stdout', 'x\n')).toThrow(BackgroundShellOutputStoreError);

    store.close('job-1');
    expect(() => store.push('job-1', 'stdout', 'x\n')).toThrow(BackgroundShellOutputStoreError);
    expect(() => store.close('job-unknown')).toThrow(BackgroundShellOutputStoreError);
    expect(() => store.open('job-1')).toThrow(BackgroundShellOutputStoreError);
  });

  it('rejects non-integer or negative constructor options', () => {
    expect(() => new BackgroundShellOutputStore({ maxBytes: -1 })).toThrow(RangeError);
    expect(() => new BackgroundShellOutputStore({ maxLines: 1.5 })).toThrow(RangeError);
    expect(() => new BackgroundShellOutputStore({ maxRetainedJobs: -2 })).toThrow(RangeError);
    expect(() => new BackgroundShellOutputStore({ maxBytes: 0 })).not.toThrow();
  });
});
