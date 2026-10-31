/** Direct wire SSE is snapshot+live, not a second journal. SSE IDs are actual durable cursors when the
 * supplied direct connection supports Session captureFrom; null cursors have no ID. The gateway's
 * historical agent-wire envelope still needs enrichment; x-term2-event-format is explicit.
 */
import type { DirectConnection, DirectReplayConnection } from './in-process-direct-types.js';
import type { WireEvent } from '../protocol/direct-wire.js';
import type { ServerResult } from './server-contracts.js';

export const SERVER_EVENT_HEARTBEAT_INTERVAL_MS = 15_000;
// Preserve the gateway's existing replay-drain and live-buffer containment policy. These limits
// detach only the network subscriber: durable Session work and future attachments remain intact.
const DRAIN_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_EVENTS = 256;
/** Owns attachment cleanup only. Backpressure never cancels the Session or blocks its execution. */
export function directEventStream(connection: DirectConnection | DirectReplayConnection): ServerResult {
  const replay = 'replay' in connection ? connection.replay : null;
  const resumable = replay !== null || (connection.snapshot !== null && connection.snapshot.seq !== null);

  return {
    status: 200,
    body: null,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-term2-event-format': 'direct-wire-v1',
      'x-term2-event-mode': replay ? 'replay-live' : 'snapshot-live',
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
        const write = (event: WireEvent): boolean =>
          !closed &&
          !response.destroyed &&
          !response.writableEnded &&
          response.write(
            `${resumable && event.seq !== null ? `id: ${event.seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
          );
        const writeDraining = async (event: WireEvent) => {
          if (write(event) || closed) return;
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              response.off('drain', done);
              response.off('close', done);
              resolve();
            };
            const timer = setTimeout(() => {
              disconnect();
              done();
            }, DRAIN_TIMEOUT_MS);
            response.once('drain', done);
            response.once('close', done);
            if (response.destroyed) done();
          });
        };
        // Consume during snapshot drain so this transport's backlog is bounded. This is only a
        // transient subscriber queue; it is never persisted or used as a reconnect authority.
        const pump = (async () => {
          for await (const event of connection.events) {
            if (closed) break;
            if (replay) {
              // The tail is (fromSeq,toSeq] only; never prepend a current snapshot.
              if (event.seq !== null && event.seq <= replay.toSeq) await writeDraining(event);
              else if (!write(event)) {
                disconnect();
                break;
              }
            } else if (live) {
              if (!write(event)) {
                disconnect();
                break;
              }
            } else if (buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event);
            else {
              disconnect();
              break;
            }
          }
        })().catch(() => {
          disconnect();
        });
        try {
          if (connection.snapshot)
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
            if (!closed && !response.write(`: heartbeat ${new Date().toISOString()}\n\n`)) disconnect();
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
