/**
 * HTTP + SSE transport binding for `GET /private/agent/v1/sessions/events` (transport-http-sse.md §4.1).
 * Emits identical Core Client API payloads (no injected protocolVersion inside data JSON) with bounded
 * backpressure, keepalive heartbeats, and clean teardown on client disconnect.
 */
import type { Principal } from '../in-process-direct-types.js';
import type { ServerResult } from '../server-contracts.js';
import type { SessionIndex, SessionListStreamEvent } from './session-index.js';
import { CLIENT_API_HTTP_VERSION } from '../../protocol/client-api/version-negotiation.js';
import { CLIENT_API_SCHEMAS } from '../../protocol/client-api/client-api-schema.js';

const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_EVENTS = 256;
const DRAIN_TIMEOUT_MS = 10_000;

export type SessionListSseOptions = {
  readonly workspaceId?: string;
  readonly limit?: number;
  readonly daemonId?: string;
  readonly negotiatedVersion?: string;
  readonly onDraining?: (
    listener: (payload: { readonly reason: 'shutdown' | 'restart'; readonly gracePeriodMs: number }) => void,
  ) => () => void;
};

function encodeSseFrame(eventName: string, payload: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function sessionListEventStream(
  index: SessionIndex,
  principal: Principal,
  options: SessionListSseOptions = {},
): ServerResult {
  const version = options.negotiatedVersion ?? CLIENT_API_HTTP_VERSION;
  let stopStream: (() => void) | null = null;
  return {
    status: 200,
    body: null,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-term2-client-api-version': version,
      ...(options.daemonId ? { 'x-term2-daemon-id': options.daemonId } : {}),
    },
    stream: {
      async start(response, request) {
        const pending: string[] = [];
        let closed = false;
        let waitingDrain = false;
        let drainTimer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;
        let unsubscribeDraining: (() => void) | null = null;

        let resolveDone: (() => void) | null = null;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });

        const clearDrain = () => {
          if (drainTimer) {
            clearTimeout(drainTimer);
            drainTimer = null;
          }
        };

        const finish = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          clearDrain();
          unsubscribe?.();
          unsubscribe = null;
          unsubscribeDraining?.();
          unsubscribeDraining = null;
          request.off('close', finish);
          response.off('close', finish);
          response.off('error', finish);
          response.off('drain', onDrain);
          if (!response.writableEnded && !response.destroyed) response.end();
          resolveDone?.();
        };
        stopStream = finish;

        const onDrain = () => {
          waitingDrain = false;
          clearDrain();
          while (!closed && !waitingDrain && pending.length > 0) {
            const chunk = pending.shift()!;
            if (!response.write(chunk)) {
              waitingDrain = true;
              drainTimer = setTimeout(() => {
                if (!closed) {
                  response.destroy();
                  finish();
                }
              }, DRAIN_TIMEOUT_MS);
              drainTimer.unref?.();
            }
          }
        };

        const enqueue = (frame: string) => {
          if (closed || response.destroyed || response.writableEnded) return;
          if (!waitingDrain && pending.length === 0) {
            if (!response.write(frame)) {
              waitingDrain = true;
              drainTimer = setTimeout(() => {
                if (!closed) {
                  response.destroy();
                  finish();
                }
              }, DRAIN_TIMEOUT_MS);
              drainTimer.unref?.();
            }
            return;
          }
          if (pending.length >= MAX_BUFFERED_EVENTS) {
            const resync = CLIENT_API_SCHEMAS.sessionListResyncRequiredEvent.parse({ reason: 'slow_consumer' });
            try {
              response.write(encodeSseFrame('session.list.resync_required', resync));
            } catch {
              // Socket already unwritable; proceed to close.
            }
            finish();
            return;
          }
          pending.push(frame);
        };

        const heartbeat = setInterval(() => {
          if (!closed && !waitingDrain && pending.length === 0) {
            enqueue(': heartbeat\n\n');
          }
        }, HEARTBEAT_MS);
        heartbeat.unref?.();

        request.on('close', finish);
        response.on('close', finish);
        response.on('error', finish);
        response.on('drain', onDrain);

        enqueue(': connected\n\n');

        if (options.onDraining) {
          unsubscribeDraining = options.onDraining((payload) => {
            enqueue(encodeSseFrame('daemon.draining', payload));
          });
        }

        const handleEvent = (event: SessionListStreamEvent) => {
          if (closed) return;
          const { event: eventName, ...payload } = event;
          enqueue(encodeSseFrame(eventName, payload));
        };

        try {
          const handle = await index.subscribe(
            principal,
            {
              ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
              ...(options.limit !== undefined ? { limit: options.limit } : {}),
            },
            handleEvent,
          );
          if (closed) handle.unsubscribe();
          else unsubscribe = handle.unsubscribe;
        } catch {
          finish();
        }
        await done;
      },
      close() {
        stopStream?.();
      },
    },
  };
}
