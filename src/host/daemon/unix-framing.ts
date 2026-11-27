/**
 * Shared NDJSON incremental line reader and bounded outbound frame writer for Unix sockets
 * (`transport-unix.md` §§2, 4.2). Reused by both `DaemonUnixServer` and the Unix client.
 */
import type net from 'node:net';

export const UNIX_MAX_INBOUND_LINE_BYTES = 4 * 1024 * 1024;
export const UNIX_MAX_OUTBOUND_FRAME_BYTES = 16 * 1024 * 1024;
export const UNIX_MAX_OUTBOUND_BUFFER_BYTES = 8 * 1024 * 1024;
export const UNIX_DRAIN_TIMEOUT_MS = 10_000;

export type IncrementalLineReaderOptions = {
  readonly maxLineBytes: number;
  readonly onLine: (line: string) => void;
  readonly onOverflow: () => void;
};

/**
 * Counts UTF-8 bytes incrementally BEFORE `\n` and triggers `onOverflow` immediately
 * when an unterminated line exceeds `maxLineBytes`.
 */
export function attachIncrementalLineReader(socket: net.Socket, options: IncrementalLineReaderOptions): () => void {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let stopped = false;

  const onData = (chunk: Buffer) => {
    if (stopped) return;
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) {
        const remaining = chunk.subarray(start);
        bytes += remaining.length;
        if (bytes > options.maxLineBytes) {
          stopped = true;
          chunks = [];
          bytes = 0;
          options.onOverflow();
          return;
        }
        chunks.push(remaining);
        return;
      }
      const piece = chunk.subarray(start, nl);
      bytes += piece.length;
      if (bytes > options.maxLineBytes) {
        stopped = true;
        chunks = [];
        bytes = 0;
        options.onOverflow();
        return;
      }
      chunks.push(piece);
      const line = Buffer.concat(chunks, bytes).toString('utf8');
      chunks = [];
      bytes = 0;
      start = nl + 1;
      if (line.length > 0) {
        options.onLine(line);
      }
    }
  };

  socket.on('data', onData);
  return () => {
    stopped = true;
    chunks = [];
    bytes = 0;
    socket.off('data', onData);
  };
}
