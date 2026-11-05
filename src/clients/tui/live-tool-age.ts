import { createContext } from 'react';

/**
 * How long a tool has been in flight, for rows drawn by `renderToString`. Legacy's rows stay mounted and time
 * themselves (visible after one second, then an elapsed counter); a one-shot render mounts every row fresh, so
 * the viewport measures the age and hands it down. Absent outside a live render (committed rows).
 */
export interface LiveToolAge {
  /** Milliseconds since the tool was first seen pending or running. */
  readonly inFlightMs: number;
  /** Milliseconds since it was first seen running, if it has started. */
  readonly runningMs?: number;
}
export const LiveToolAgeContext = createContext<LiveToolAge | undefined>(undefined);

/** Ages of the in-flight tools, by tool id, supplied by the viewport around a live render. */
export const LiveToolAgesContext = createContext<ReadonlyMap<string, LiveToolAge> | undefined>(undefined);
