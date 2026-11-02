import { useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import type { DirectConnection, DirectReplayConnection } from '../../host/in-process-direct-types.js';
import type { WireEvent, WireSnapshot } from '../../protocol/direct-wire.js';
import { reduceWireEvent } from '../../protocol/direct-reducer.js';
import { projectSnapshot } from './direct-projection.js';
import type { TuiState } from './state.js';

type ClientConnection = DirectConnection | DirectReplayConnection;
function initialSnapshot(connection: ClientConnection, retained?: WireSnapshot): WireSnapshot {
  if (connection.snapshot) return connection.snapshot;
  if (!retained || retained.sessionId !== connection.sessionId || retained.seq !== connection.replay.fromSeq) {
    throw new Error('Replay requires retained state at the exact requested session and durable cursor.');
  }
  return retained;
}

/** Fold snapshot/catch-up/live state. The optional observer sees new durable non-snapshot events only. */
export function useClient(
  connection: ClientConnection,
  retained?: WireSnapshot,
  onSnapshot?: (state: WireSnapshot) => void,
  onLiveEvent?: (event: WireEvent) => void,
): { state: TuiState; error: string | null; historyRevision: number } {
  const callback = useRef(onSnapshot);
  callback.current = onSnapshot;
  const liveCallback = useRef(onLiveEvent);
  liveCallback.current = onLiveEvent;
  const [current, setCurrent] = useState(() => ({
    connection,
    wire: initialSnapshot(connection, retained),
    error: null as string | null,
    historyRevision: 0,
  }));
  const visible =
    current.connection === connection
      ? current
      : { connection, wire: initialSnapshot(connection, retained), error: null, historyRevision: 0 };
  useEffect(() => {
    let active = true;
    let wire = initialSnapshot(connection, retained);
    let historyRevision = 0;
    let awaitingReplacement = false;
    setCurrent({ connection, wire, error: null, historyRevision });
    callback.current?.(wire);
    void (async () => {
      try {
        // The wire wakes this attached client; only Session may consume notices
        // and admit their silent turn. Never resume a paused user queue to do so.
        const drain = async () => {
          if (!active || wire.status !== 'idle' || wire.activeTurnId || wire.queueState !== 'idle' || wire.queue.length)
            return;
          const delivered = new Set(wire.notifications?.deliveries.flatMap((item) => item.notificationIds));
          if (!wire.notifications?.notices.some((item) => !delivered.has(item.id))) return;
          const result = await connection.send({
            type: 'drain_background_notifications',
            requestId: `drain_${randomUUID()}`,
          });
          if (!result.ok) throw new Error(`Background notification drain failed: ${result.message}`);
        };
        await drain();
        for await (const event of connection.events) {
          if (!active) return;
          // Snapshots and replay at/before the attached cut are not new work.
          const live = event.type !== 'snapshot' && event.seq !== null && event.seq > (wire.seq ?? -1);
          if (event.type === 'history_replaced' && !event.payload.retainTranscript) awaitingReplacement = true;
          wire = reduceWireEvent(wire, event);
          if (event.type === 'snapshot' && awaitingReplacement) {
            historyRevision++;
            awaitingReplacement = false;
          }
          setCurrent({ connection, wire, error: null, historyRevision });
          callback.current?.(wire);
          if (live) liveCallback.current?.(event);
          // Await admission, not completion. Keep one attempt in flight without
          // timers; a busy Session is reconsidered at its next wire boundary.
          await drain();
        }
        if (active)
          setCurrent((previous) =>
            previous.connection === connection ? { ...previous, error: 'Connection closed.' } : previous,
          );
      } catch (error) {
        if (active)
          setCurrent((previous) =>
            previous.connection === connection
              ? { ...previous, error: `Connection failed: ${error instanceof Error ? error.message : String(error)}` }
              : previous,
          );
      }
    })();
    return () => {
      active = false;
      connection.close();
    };
  }, [connection]);
  // Viewport measurements update local React state. Keep their unchanged wire
  // input stable so those updates do not schedule another transcript render.
  const state = useMemo(() => projectSnapshot(visible.wire), [visible.wire]);
  return { state, error: visible.error, historyRevision: visible.historyRevision };
}
