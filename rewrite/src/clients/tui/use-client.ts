import { useEffect, useState } from 'react';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import { projectEvent, projectSnapshot } from './direct-projection.js';
import type { TuiState } from './state.js';

/** Consume the direct connection's initial snapshot, then its ordered live stream. */
export function useClient(connection: DirectConnection): { state: TuiState; error: string | null } {
  const [current, setCurrent] = useState(() => ({ connection, state: projectSnapshot(connection.snapshot), error: null as string | null }));
  const visible = current.connection === connection
    ? current
    : { connection, state: projectSnapshot(connection.snapshot), error: null };

  useEffect(() => {
    let active = true;
    setCurrent({ connection, state: projectSnapshot(connection.snapshot), error: null });
    void (async () => {
      try {
        for await (const event of connection.events) {
          if (!active) return;
          setCurrent(previous => previous.connection === connection
            ? { ...previous, state: projectEvent(previous.state, event) } : previous);
        }
        if (active) setCurrent(previous => previous.connection === connection
          ? { ...previous, error: 'Connection closed.' } : previous);
      } catch (error) {
        if (active) setCurrent(previous => previous.connection === connection
          ? { ...previous, error: `Connection failed: ${error instanceof Error ? error.message : String(error)}` } : previous);
      }
    })();
    return () => { active = false; connection.close(); };
  }, [connection]);
  return { state: visible.state, error: visible.error };
}
