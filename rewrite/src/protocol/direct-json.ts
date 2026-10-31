/** Exact legacy records for native producers that actually exist. This is NOT a
 * complete --json read model: callers must retain the fail-closed legacy gate.
 */
import type { CommandMessage } from '../../../source/tools/types.js';
import type { CommandMessageEvent, CostUpdateEvent } from '../../../source/services/conversation/conversation-events.js';
import type { WireEvent } from './direct-wire.js';

/** Project one actual settled request record verbatim; ancestry remains on the wire
 * envelope. Select the owning root/tree before using this in a per-run legacy sink.
 * Same-request corrections are updates, never another unique billed request.
 */
export function legacyRequestCostUpdate(event: Extract<WireEvent, { readonly type: 'request_cost_recorded' }>): CostUpdateEvent {
  return { type: 'cost_update', record: structuredClone(event.payload.record) };
}

/** Project only complete source-formatted command DTOs retained in accepted tool
 * display. Missing/foreign display produces no record, never blank success or a
 * fabricated ID/status. Callers retain turn/branch scope and upsert by message ID;
 * this helper does not construct an authoritative final/turn-item window.
 */
export function legacyCommandMessages(event: Extract<WireEvent, { readonly type: 'tool_finished' }>): CommandMessageEvent[] {
  const display = event.payload.display;
  const messages = Array.isArray(display)
    ? display
    : display && typeof display === 'object' && 'messages' in display
      ? display.messages
      : undefined;
  if (!Array.isArray(messages)) return [];
  return messages.filter(isCommandMessage).map(message => ({
    type: 'command_message', message: structuredClone(message),
  }));
}

/** Recognize the existing source DTO, not arbitrary tool output or presentation. */
function isCommandMessage(value: unknown): value is CommandMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return typeof message.id === 'string' && message.sender === 'command'
    && typeof message.command === 'string' && typeof message.output === 'string'
    && ['pending', 'running', 'completed', 'failed', 'aborted', 'unknown'].some(status => status === message.status)
    && ['success', 'isApprovalRejection', 'autoApprovedByLlm'].every(key => message[key] === undefined || typeof message[key] === 'boolean')
    && ['failureReason', 'toolName', 'callId'].every(key => message[key] === undefined || typeof message[key] === 'string');
}
