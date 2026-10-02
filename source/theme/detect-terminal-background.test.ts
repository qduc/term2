import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectTerminalBackground } from './detect-terminal-background.js';

const OSC11_QUERY = '\u001B]11;?\u001B\\';
const DA1_QUERY = '\u001B[c';
const DA1_REPLY = '\u001B[?62;c';

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  rawCalls: boolean[] = [];
  /** Mirrors Node: `null` until the stream is first read, then true/false. */
  get readableFlowing(): boolean | null {
    return this.paused ? null : true;
  }
  setRawMode(value: boolean) {
    this.rawCalls.push(value);
    this.isRaw = value;
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
  setEncoding() {
    return this;
  }
}

class FakeStdout {
  isTTY = true;
  written: string[] = [];
  write(chunk: string) {
    this.written.push(chunk);
    return true;
  }
}

const setup = () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  return { stdin, stdout, streams: { stdin: stdin as never, stdout: stdout as never } };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('detectTerminalBackground', () => {
  it('asks for the background colour and then for device attributes', async () => {
    const { stdin, stdout, streams } = setup();
    const pending = detectTerminalBackground({ ...streams, timeoutMs: 50 });
    stdin.emit('data', DA1_REPLY);
    await pending;
    expect(stdout.written.join('')).toBe(OSC11_QUERY + DA1_QUERY);
  });

  it('reports a light background from an OSC 11 reply', async () => {
    const { stdin, streams } = setup();
    const pending = detectTerminalBackground({ ...streams, timeoutMs: 50 });
    stdin.emit('data', '\u001B]11;rgb:ffff/ffff/ffff\u001B\\' + DA1_REPLY);
    await expect(pending).resolves.toBe('light');
  });

  it('reports a dark background from an OSC 11 reply', async () => {
    const { stdin, streams } = setup();
    const pending = detectTerminalBackground({ ...streams, timeoutMs: 50 });
    stdin.emit('data', '\u001B]11;rgb:0d0d/1111/1717\u0007' + DA1_REPLY);
    await expect(pending).resolves.toBe('dark');
  });

  it('reassembles a reply split across several chunks', async () => {
    const { stdin, streams } = setup();
    const pending = detectTerminalBackground({ ...streams, timeoutMs: 50 });
    stdin.emit('data', '\u001B]11;rgb:ff');
    stdin.emit('data', 'ff/ffff/ff');
    stdin.emit('data', 'ff\u001B\\');
    stdin.emit('data', DA1_REPLY);
    await expect(pending).resolves.toBe('light');
  });

  it('resolves immediately with nothing when the terminal answers only device attributes', async () => {
    vi.useFakeTimers();
    const { stdin, streams } = setup();
    const pending = detectTerminalBackground({ ...streams, timeoutMs: 5_000 });
    stdin.emit('data', DA1_REPLY);
    // No timer advance: an unsupported terminal must not cost the full timeout.
    await expect(pending).resolves.toBeUndefined();
  });

  it('gives up after the timeout when the terminal is silent', async () => {
    vi.useFakeTimers();
    const { streams } = setup();
    const pending = detectTerminalBackground({ ...streams, timeoutMs: 150 });
    await vi.advanceTimersByTimeAsync(150);
    await expect(pending).resolves.toBeUndefined();
  });

  it('uses a colour reply that arrived even if device attributes never follow', async () => {
    vi.useFakeTimers();
    const { stdin, streams } = setup();
    const pending = detectTerminalBackground({ ...streams, timeoutMs: 150 });
    stdin.emit('data', '\u001B]11;rgb:ffff/ffff/ffff\u0007');
    await vi.advanceTimersByTimeAsync(150);
    await expect(pending).resolves.toBe('light');
  });

  it('restores raw mode, stops listening, and re-pauses stdin it resumed', async () => {
    const { stdin, streams } = setup();
    const pending = detectTerminalBackground({ ...streams, timeoutMs: 50 });
    expect(stdin.isRaw).toBe(true);
    expect(stdin.paused).toBe(false);
    stdin.emit('data', DA1_REPLY);
    await pending;
    expect(stdin.rawCalls).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.paused).toBe(true);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('leaves stdin flowing when it was already flowing', async () => {
    const { stdin, streams } = setup();
    stdin.paused = false;
    const pending = detectTerminalBackground({ ...streams, timeoutMs: 50 });
    stdin.emit('data', DA1_REPLY);
    await pending;
    expect(stdin.paused).toBe(false);
  });

  it.each([
    ['stdin is not a TTY', (s: ReturnType<typeof setup>) => (s.stdin.isTTY = false)],
    ['stdout is not a TTY', (s: ReturnType<typeof setup>) => (s.stdout.isTTY = false)],
  ])('does not touch the terminal when %s', async (_name, arrange) => {
    const s = setup();
    arrange(s);
    await expect(detectTerminalBackground({ ...s.streams, timeoutMs: 50 })).resolves.toBeUndefined();
    expect(s.stdout.written).toEqual([]);
    expect(s.stdin.rawCalls).toEqual([]);
  });

  it('does not touch the terminal when raw mode is unavailable', async () => {
    const s = setup();
    (s.stdin as { setRawMode?: unknown }).setRawMode = undefined;
    await expect(detectTerminalBackground({ ...s.streams, timeoutMs: 50 })).resolves.toBeUndefined();
    expect(s.stdout.written).toEqual([]);
  });
});
