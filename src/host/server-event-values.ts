/** Shared pinned-event value constraints: accepted identity, sanitization and refusal.
 * These are projection rules, not new admission or execution limits.
 */
import type { AgentEventType } from '@qduc/agent-wire';
import type { WireEvent, WireTask } from '../protocol/wire.js';
import { ServerHttpError } from './server-errors.js';

export type CanonicalEventContext = {
  /** Accepted immutable task owner at the replay cut; never the latest unrelated task. */
  readonly task?: WireTask;
};
export type CanonicalEventCandidate = { type: AgentEventType; payload: Readonly<Record<string, unknown>> };

export function requiredTurn(event: WireEvent): string {
  return event.turnId ?? missing('canonical turn event requires its accepted turn identity');
}
export function text(value: string, max = 65_536): string {
  return value.slice(0, max).replace(/[\u0000\u007f]/gu, '\uFFFD');
}
export function errorReason(kind: string | undefined): string {
  switch (kind) {
    case 'provider':
      return 'provider_error';
    case 'network':
      return 'network_error';
    case 'authentication':
      return 'authentication_error';
    case 'rate_limit':
      return 'rate_limit';
    case 'cancelled':
      return 'cancelled';
    case 'validation':
      return 'validation_error';
    case 'compaction':
      return 'compaction_failed';
    case 'retry_exhausted':
      return 'retry_exhausted';
    default:
      return 'runtime_error';
  }
}
export function missing(message: string): never {
  throw new ServerHttpError(503, 'event_envelope_unavailable', message, true, { reloadRequired: true });
}
