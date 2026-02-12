/**
 * Synchronized Output wrapper for terminal rendering.
 *
 * Wraps stdout.write() calls with DEC Mode 2026 escape sequences
 * (\x1b[?2026h to begin, \x1b[?2026l to end) so that terminal
 * emulators which support it (iTerm2, WezTerm, foot, etc.) will
 * buffer the entire update and render it as a single atomic frame.
 *
 * This eliminates the flickering that occurs in iTerm2 because Ink's
 * incremental renderer issues multiple ANSI cursor-movement + erase
 * sequences per render cycle; without synchronized output the terminal
 * may render intermediate states (partially erased content) between
 * individual write() calls.
 *
 * Terminals that do NOT support mode 2026 will silently ignore the
 * escape sequences, so this is safe to enable unconditionally.
 *
 * Reference: https://gist.github.com/christianparpart/d8a62cc1ab659194571cd32e76cfd588
 */

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

/**
 * Check if the terminal likely supports synchronized output.
 * iTerm2, WezTerm, foot, and many modern terminals support it.
 * We enable it broadly since unsupported terminals just ignore the sequences.
 */
export function isSynchronizedOutputSupported(): boolean {
  // Always return true — unsupported terminals silently ignore mode 2026.
  // This keeps the logic simple and avoids false negatives.
  return true;
}

/**
 * Wraps a stdout write so the content is emitted inside a synchronized
 * output block (DEC Mode 2026). The wrapper preserves the original
 * `write()` signature and injects begin/end markers around each call.
 *
 * Usage:
 *   patchStdoutForSynchronizedOutput(process.stdout);
 */
export function patchStdoutForSynchronizedOutput(stream: NodeJS.WriteStream): void {
  if (!isSynchronizedOutputSupported()) {
    return;
  }

  const originalWrite = stream.write.bind(stream) as typeof stream.write;

  // Track nesting to avoid double-wrapping when Ink's own clear/write
  // sequences trigger multiple write calls synchronously.
  let syncing = false;

  stream.write = function (
    chunk: any,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    // Avoid double-wrapping and only wrap string data (ANSI sequences).
    // Binary data or nested calls pass through unchanged.
    if (syncing || typeof chunk !== 'string') {
      return originalWrite(chunk, encodingOrCallback as any, callback);
    }

    syncing = true;
    try {
      // Prefix the payload with the sync-start marker and suffix with
      // sync-end, all in a single write to minimise I/O calls.
      const wrapped = SYNC_START + chunk + SYNC_END;
      return originalWrite(wrapped, encodingOrCallback as any, callback);
    } finally {
      syncing = false;
    }
  } as typeof stream.write;
}
