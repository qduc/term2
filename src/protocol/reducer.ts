/** term2's binding of the shared fold (./fold/): the same fold with term2's tool labels. */
import { formatToolCommand } from '../tools/conversation-utils.js';
import { reduceWireEvent as foldWireEvent, type WireFoldOptions } from './fold/wire-fold.js';
import type { WireEvent, WireSnapshot } from './wire.js';

/** What term2 supplies to the fold everywhere it runs, the browser bundle included (./fold-browser.ts). */
export const TERM2_WIRE_FOLD_OPTIONS: WireFoldOptions = { formatToolLabel: formatToolCommand };

export function reduceWireEvent(state: WireSnapshot, event: WireEvent): WireSnapshot {
  return foldWireEvent(state, event, TERM2_WIRE_FOLD_OPTIONS);
}
