import { useEffect, useState } from 'react';
import type { Connection } from '../../host/index.js';
import type { TuiIntegration } from './integration.js';
import { updateView, type TuiState } from './state.js';

/** Consume the connection's initial atomic snapshot, then its ordered live stream. */
export function useClient(connection: Connection, integration: TuiIntegration): { state: TuiState; error: string | null } {
  const [current, setCurrent] = useState(() => ({ connection, integration, state: integration.snapshot(connection.snapshot), error: null as string | null }));
  // Render a new session's snapshot immediately instead of showing the previous session for one frame.
  const visible = current.connection === connection && current.integration === integration
    ? current
    : { connection, integration, state: integration.snapshot(connection.snapshot), error: null };

  useEffect(() => {
    let active = true;
    setCurrent({ connection, integration, state: integration.snapshot(connection.snapshot), error: null });
    void (async () => {
      try {
        for await (const event of connection.events) {
          if (!active) return;
          const updates = integration.event(event);
          setCurrent(previous => {
            if (previous.connection !== connection || previous.integration !== integration) return previous;
            return { ...previous, state: updates.reduce(updateView, previous.state) };
          });
        }
        if (active) setCurrent(previous => previous.connection === connection && previous.integration === integration
          ? { ...previous, error: 'Connection closed.' } : previous);
      } catch (error) {
        if (active) setCurrent(previous => previous.connection === connection && previous.integration === integration
          ? { ...previous, error: `Connection failed: ${error instanceof Error ? error.message : String(error)}` } : previous);
      }
    })();
    return () => { active = false; connection.close(); };
  }, [connection, integration]);
  return { state: visible.state, error: visible.error };
}
