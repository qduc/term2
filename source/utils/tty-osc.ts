import fs from 'fs';

export type TtyWriter = (data: string) => void;

/**
 * Returns a function that writes a string to the terminal TTY.
 * Prefers process.stdout when it is a TTY; falls back to opening /dev/tty
 * directly so the sequence reaches the terminal even when stdout is redirected
 * (e.g. through the synchronized-output patch or pipe).
 */
export function getTtyWriter(): TtyWriter | null {
  if (process.stdout.isTTY) {
    return (data) => void process.stdout.write(data);
  }

  try {
    const fd = fs.openSync('/dev/tty', 'w');
    fs.closeSync(fd);

    return (data) => {
      const writeFd = fs.openSync('/dev/tty', 'w');
      try {
        fs.writeSync(writeFd, data);
      } finally {
        fs.closeSync(writeFd);
      }
    };
  } catch {
    return null;
  }
}

/**
 * Wraps a raw OSC inner sequence for delivery through a terminal multiplexer
 * (tmux or GNU screen). In a bare terminal the sequence is returned unchanged.
 *
 * - tmux: DCS passthrough — double every ESC in the inner sequence.
 * - screen: DCS passthrough — chunk at 768 chars to stay within screen's
 *   internal buffer limit.
 */
export function wrapForMultiplexer(inner: string, env: NodeJS.ProcessEnv): string {
  if (env.TMUX) {
    // tmux DCS passthrough: double each ESC in the inner sequence
    const escaped = inner.replace(/\x1b/g, '\x1b\x1b');
    return `\x1bPtmux;\x1b${escaped}\x1b\\`;
  }

  if (env.TERM?.startsWith('screen')) {
    // screen DCS passthrough: chunk at 768 chars to stay within screen's buffer limit
    const CHUNK_SIZE = 768;
    let result = '';
    for (let i = 0; i < inner.length; i += CHUNK_SIZE) {
      result += `\x1bP${inner.slice(i, i + CHUNK_SIZE)}\x1b\\`;
    }
    return result;
  }

  return inner;
}

export interface WriteOscOptions {
  env?: NodeJS.ProcessEnv;
  getTtyWriter?: () => TtyWriter | null;
}

/**
 * Wraps an OSC inner sequence for the current multiplexer (if any) and writes
 * it to the TTY. Silently does nothing if no TTY is available.
 */
export function writeOscSequence(inner: string, opts: WriteOscOptions = {}): void {
  const env = opts.env ?? process.env;
  const getWriter = opts.getTtyWriter ?? getTtyWriter;
  const writer = getWriter();
  if (!writer) return;
  writer(wrapForMultiplexer(inner, env));
}
