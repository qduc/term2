/** Direct wire SSE is snapshot+live, not a second journal. SSE IDs are actual durable cursors when the
 * supplied direct connection supports Session captureFrom; null cursors have no ID. The gateway's
 * historical agent-wire envelope still needs enrichment; x-term2-event-format is explicit.
 */
import type { DirectConnection, DirectReplayConnection } from './in-process-direct-types.js';
import type { WireEvent } from '../protocol/wire.js';
import type { AgentWireV2Envelope } from './server-wire-v2.js';
import type { ServerResult } from './server-contracts.js';

const SERVER_EVENT_HEARTBEAT_INTERVAL_MS = 15_000;
// Containment for a subscriber that stops reading. These limits detach only the network
// subscriber: durable Session work and future attachments remain intact. A full socket buffer
// (write() returning false) is ordinary backpressure during a burst, not evidence of a dead
// reader, so every frame write waits for drain. A subscriber whose frame writes have stayed
// backpressured for DRAIN_TIMEOUT_MS in total is detached: that covers a reader that stopped and
// one that keeps reading but slower than the Session emits, and bounds the queued backlog to
// roughly DRAIN_TIMEOUT_MS of output. A write that is accepted below the buffer limit resets it.
const DRAIN_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_EVENTS = 256;
type StreamFrame = { readonly id: number | null; readonly event?: 'accepted' | 'live'; readonly data: unknown };
type StreamEncoding = {
  readonly format: 'direct-wire-v1' | 'agent-wire-v2';
  /** V2 accepted frames retain their real accepted seq even when replay is unavailable. */
  readonly acceptedIds?: boolean;
  readonly snapshot: boolean;
  encode(event: WireEvent): StreamFrame | null;
};
/** Owns attachment cleanup only. Backpressure never cancels the Session or blocks its execution. */
export function directEventStream(connection: DirectConnection | DirectReplayConnection): ServerResult {
  return eventStream(connection, {
    format: 'direct-wire-v1',
    snapshot: true,
    encode: (event) => ({ id: event.seq, data: event }),
  });
}
export function agentWireV2EventStream(
  connection: DirectConnection | DirectReplayConnection,
  encode: (event: WireEvent) => AgentWireV2Envelope | null,
): ServerResult {
  return eventStream(connection, {
    format: 'agent-wire-v2',
    snapshot: false,
    acceptedIds: true,
    encode(event) {
      const envelope = encode(event);
      if (!envelope) return null;
      return {
        id: envelope.kind === 'accepted' ? envelope.seq : null,
        event: envelope.kind,
        data: envelope,
      };
    },
  });
}
function eventStream(connection: DirectConnection | DirectReplayConnection, encoding: StreamEncoding): ServerResult {
  const replay = 'replay' in connection ? connection.replay : null;
  const resumable =
    replay !== null || (encoding.snapshot && connection.snapshot !== null && connection.snapshot.seq !== null);

  return {
    status: 200,
    body: null,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-term2-event-format': encoding.format,
      'x-term2-event-mode': replay ? 'replay-live' : encoding.snapshot ? 'snapshot-live' : 'live',
      'x-term2-replay': resumable ? 'atomic' : 'unavailable',
      ...(replay ? { 'x-term2-replay-from': String(replay.fromSeq), 'x-term2-replay-to': String(replay.toSeq) } : {}),
    },
    stream: {
      close: () => connection.close(),
      async start(response, request) {
        let closed = false;
        let live = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let releaseClose!: () => void;
        const whenClosed = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        const buffered: WireEvent[] = [];
        const close = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          response.off('close', close);
          request.off('aborted', disconnect);
          connection.close();
          releaseClose();
        };
        const disconnect = () => {
          response.destroy();
          close();
        };
        response.once('close', close);
        request.once('aborted', disconnect);
        if (response.destroyed || request.aborted) {
          disconnect();
          return;
        }
        // A comment establishes the downstream BFF/browser stream immediately.
        // Headers alone can remain buffered by an HTTP streaming proxy until
        // the first body byte; v2 has no initial snapshot event to provide it.
        if (!response.write(': connected\n\n')) {
          disconnect();
          return;
        }
        const write = (event: WireEvent): boolean => {
          if (closed || response.destroyed || response.writableEnded) return false;
          const frame = encoding.encode(event);
          // Folded read-model updates are not SSE frames and consume no numeric cursor.
          if (!frame) return true;
          const eventLine = frame.event ? `event: ${frame.event}\n` : '';
          const idLine = (resumable || encoding.acceptedIds) && frame.id !== null ? `id: ${frame.id}\n` : '';
          return response.write(`${eventLine}${idLine}data: ${JSON.stringify(frame.data)}\n\n`);
        };
        const waitForDrain = (timeoutMs = DRAIN_TIMEOUT_MS) =>
          new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              response.off('drain', done);
              response.off('close', done);
              resolve();
            };
            const timer = setTimeout(() => {
              disconnect();
              done();
            }, Math.max(0, timeoutMs));
            response.once('drain', done);
            response.once('close', done);
            if (response.destroyed) done();
          });
        // When frame writes first stopped fitting the buffer; null once a write fits again.
        let backpressuredSince: number | null = null;
        const writeDraining = async (event: WireEvent) => {
          if (write(event)) {
            backpressuredSince = null;
            return;
          }
          if (closed) return;
          backpressuredSince ??= Date.now();
          await waitForDrain(DRAIN_TIMEOUT_MS - (Date.now() - backpressuredSince));
        };
        // Consume during snapshot drain so this transport's backlog is bounded. This is only a
        // transient subscriber queue; it is never persisted or used as a reconnect authority.
        const pump = (async () => {
          for await (const event of connection.events) {
            if (closed) break;
            // A replay tail is (fromSeq,toSeq] only; never prepend a current snapshot.
            if (replay || live) await writeDraining(event);
            else if (buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event);
            else {
              disconnect();
              break;
            }
          }
        })().catch(() => {
          disconnect();
        });
        try {
          if (encoding.snapshot && connection.snapshot)
            await writeDraining({
              sessionId: connection.sessionId,
              seq: connection.snapshot.seq,
              turnId: null,
              type: 'snapshot',
              payload: { snapshot: connection.snapshot },
            });
          while (!closed && buffered.length) await writeDraining(buffered.shift()!);
          if (closed) return;
          // No await at the empty-buffer/live-cut boundary.
          live = true;
          heartbeat = setInterval(() => {
            if (!closed && !response.write(`: heartbeat ${new Date().toISOString()}\n\n`)) void waitForDrain();
          }, SERVER_EVENT_HEARTBEAT_INTERVAL_MS);
          heartbeat.unref?.();
          await Promise.race([pump, whenClosed]);
        } finally {
          close();
          if (!response.destroyed && !response.writableEnded) response.end();
        }
      },
    },
  };
}
