/** Exact legacy records for native producers that actually exist. The accepted
 * terminal window is exposed separately through WireTerminal.finalWindow; this
 * module does not claim the complete legacy ConversationEvent schema.
 */
import type { CommandMessage } from '../../../source/tools/types.js';
import type { CommandMessageEvent, CostUpdateEvent, FinalResponseEvent, ReasoningDeltaEvent, TextDeltaEvent, ToolCallStreamingDeltaEvent } from '../../../source/services/conversation/conversation-events.js';
import type { WireEvent, WireFinalWindow } from './direct-wire.js';

/** Static negative capability for the complete old ConversationEvent schema.
 * The bounded accepted final window is exposed separately on WireTerminal;
 * it does not supply providerHistory or the remaining legacy event families.
 */
export const DIRECT_LEGACY_JSON_FINAL_WINDOW_AVAILABLE = false;

/** Copy the actual text chunk only. Select its owning turn/branch before emitting.
 * fullText is optional in the source DTO and deliberately omitted: a message draft
 * or public transcript is not the complete legacy turn-wide streamed prefix.
 */
export function legacyTextDelta(event: Extract<WireEvent, { readonly type: 'text_delta' }>): TextDeltaEvent {
  return { type: 'text_delta', delta: event.payload.delta };
}

/** Copy only a real live reasoning chunk, not an accepted summary relabelled as a
 * delta. No fullText: native transients do not supply a complete replayable prefix.
 * Ownership remains on the wire envelope; this helper creates no block identity.
 */
export function legacyReasoningDelta(event: Extract<WireEvent, { readonly type: 'reasoning_delta' }>): ReasoningDeltaEvent {
  return { type: 'reasoning_delta', delta: event.payload.delta };
}

/** Project the immutable accepted terminal window into the old final DTO. The caller
 * passes command IDs it actually emitted live; those are omitted from final exactly as
 * the old stream did. providerHistory and private provider items are never synthesized. */
export type LegacyFinalResponse = FinalResponseEvent & { readonly legacyCoverage?: WireFinalWindow['coverage'] };
export function legacyFinalResponse(window: WireFinalWindow, emittedCommandMessageIds: ReadonlySet<string>): LegacyFinalResponse {
  const record = window.record;
  const commandMessages = record.commandMessages.filter(message => !emittedCommandMessageIds.has(message.id));
  return {
    type: 'final',
    finalText: record.finalText,
    ...(record.reasoningText !== undefined ? { reasoningText: record.reasoningText } : {}),
    ...(commandMessages.length > 0 ? { commandMessages: commandMessages.map(message => structuredClone(message)) } : {}),
    ...(record.usage !== undefined ? { usage: { ...record.usage } } : {}),
    ...(record.costRecords.length > 0 ? { costRecords: record.costRecords.map(cost => structuredClone(cost)) } : {}),
    ...(record.turnItems.length > 0 ? { turnItems: record.turnItems.map(item => structuredClone(item)) } : {}),
    ...(record.terminalCause !== undefined ? { terminalCause: record.terminalCause } : {}),
    // Extra provenance field: old consumers ignore it; it makes public-item/private
    // omissions and accepted-summary/usage limits explicit instead of silent.
    legacyCoverage: { ...window.coverage },
  };
}

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

/** Emit only the old actual count/name DTO. Producing turn/step/call/branch scope
 * stays in the wire envelope; no raw delta or finalized call is reconstructed.
 */
export function legacyToolCallStreamingDelta(event: Extract<WireEvent, { readonly type: 'tool_call_streaming_delta' }>): ToolCallStreamingDeltaEvent {
  return { type: 'tool_call_streaming_delta', argumentCharCount: event.payload.argumentCharCount,
    ...(event.payload.toolName !== undefined ? { toolName: event.payload.toolName } : {}) };
}
