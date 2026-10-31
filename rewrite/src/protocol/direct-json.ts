/** Exact legacy records for native producers that actually exist. This is NOT a
 * complete --json read model: callers must retain the fail-closed legacy gate.
 */
import type { CostUpdateEvent } from '../../../source/services/conversation/conversation-events.js';
import type { WireEvent } from './direct-wire.js';

/** Project one actual settled request record verbatim; ancestry remains on the wire
 * envelope. Select the owning root/tree before using this in a per-run legacy sink.
 * Same-request corrections are updates, never another unique billed request.
 */
export function legacyRequestCostUpdate(event: Extract<WireEvent, { readonly type: 'request_cost_recorded' }>): CostUpdateEvent {
  return { type: 'cost_update', record: structuredClone(event.payload.record) };
}
