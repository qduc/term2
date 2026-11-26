/**
 * The browser's copy of the shared fold, bundled into the web client by scripts/build-web-fold.mjs. It binds
 * the same options as every server-side caller (./reducer.ts), so a snapshot the browser folds from events
 * equals the one the server folds; only the fold and the tool-label formatter are in the bundle.
 */
import type { WireEvent, WireSnapshot } from './fold/index.js';
import { reduceWireEvent as foldWireEvent } from './fold/index.js';
import { TERM2_WIRE_FOLD_OPTIONS } from './reducer.js';

export type * from './fold/index.js';

export function reduceWireEvent(state: WireSnapshot, event: WireEvent): WireSnapshot {
  return foldWireEvent(state, event, TERM2_WIRE_FOLD_OPTIONS);
}
