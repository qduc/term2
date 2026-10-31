import { useEffect, useRef, useState } from 'react';
import type { DirectConnection, DirectReplayConnection } from '../../host/in-process-direct-types.js';
import type { WireSnapshot } from '../../protocol/direct-wire.js';
import { reduceWireEvent } from '../../protocol/direct-reducer.js';
import { projectSnapshot } from './direct-projection.js';
import type { TuiState } from './state.js';
import { presentEvent, type LiveEvent } from './event-presentation.js';

type ClientConnection = DirectConnection | DirectReplayConnection;
function initialSnapshot(connection: ClientConnection, retained?: WireSnapshot): WireSnapshot {
  if (connection.snapshot) return connection.snapshot;
  if (!retained || retained.sessionId !== connection.sessionId || retained.seq !== connection.replay.fromSeq) {
    throw new Error('Replay requires retained state at the exact requested session and durable cursor.');
  }
  return retained;
}

/** Fold a fresh snapshot or a retained cursor state, then ordered catch-up and live events. */
export function useClient(connection: ClientConnection, retained?: WireSnapshot, onSnapshot?: (state: WireSnapshot) => void): { state: TuiState; error: string | null } {
  const callback = useRef(onSnapshot);
  callback.current = onSnapshot;
  const [current, setCurrent] = useState(() => ({ connection, wire: initialSnapshot(connection, retained), liveEvents: [] as readonly LiveEvent[], error: null as string | null }));
  const visible = current.connection === connection ? current : { connection, wire: initialSnapshot(connection, retained), liveEvents: [] as readonly LiveEvent[], error: null };
  useEffect(() => {
    let active = true;
    let wire = initialSnapshot(connection, retained);
    let liveEvents: readonly LiveEvent[] = [];
    setCurrent({ connection, wire, liveEvents, error: null });
    callback.current?.(wire);
    void (async () => {
      try {
        for await (const event of connection.events) {
          if (!active) return;
          wire = reduceWireEvent(wire, event);
          liveEvents = presentEvent(liveEvents, event);
          setCurrent({ connection, wire, liveEvents, error: null });
          callback.current?.(wire);
        }
        if (active) setCurrent(previous => previous.connection === connection ? { ...previous, error: 'Connection closed.' } : previous);
      } catch (error) {
        if (active) setCurrent(previous => previous.connection === connection
          ? { ...previous, error: `Connection failed: ${error instanceof Error ? error.message : String(error)}` } : previous);
      }
    })();
    return () => { active = false; connection.close(); };
  }, [connection]);
  return { state: { ...projectSnapshot(visible.wire), liveEvents: visible.liveEvents }, error: visible.error };
}
