/** Exact legacy records for native producers that actually exist. The accepted
 * terminal window is exposed separately through WireTerminal.finalWindow; this
 * module does not claim the complete legacy ConversationEvent schema.
 */
import type { CommandMessage } from '../tools/types.js';
import type { ModelRequestCost } from '../shared/cost/model-cost.js';
import { getModelPricing } from '../model/cost/pricing.js';
import type {
  CommandMessageEvent,
  CostUpdateEvent,
  FinalResponseEvent,
  ReasoningDeltaEvent,
  RetryEvent,
  RunBudgetEventNotice,
  TextDeltaEvent,
  ToolCallStreamingDeltaEvent,
  ToolDispatchedEvent,
  ToolStartedEvent,
  UsageUpdateEvent,
} from '../session/conversation/conversation-events.js';
import type { WireBudgetEvidence, WireEvent, WireFinalWindow, WireUsage } from './wire.js';

// Retained presentation helpers cross the source boundary here, never in clients.
export { formatGoalClosedByCheck } from '../session/conversation/durable-goal.js';
/** Legacy's one-line tool label (the task panel's newest-call row). */
export { formatToolCommand } from '../tools/conversation-utils.js';

/** Copy the actual text chunk. fullText is supplied only by a caller that has
 * observed this message's stream from its first delta; no transcript is treated
 * as a complete prefix. */
export function legacyTextDelta(
  event: Extract<WireEvent, { readonly type: 'text_delta' }>,
  fullText?: string,
): TextDeltaEvent {
  return { type: 'text_delta', delta: event.payload.delta, ...(fullText !== undefined ? { fullText } : {}) };
}

/** Copy only a real live reasoning chunk, not an accepted summary relabelled as a
 * delta. No fullText: native transients do not supply a complete replayable prefix.
 * Ownership remains on the wire envelope; this helper creates no block identity.
 */
export function legacyReasoningDelta(
  event: Extract<WireEvent, { readonly type: 'reasoning_delta' }>,
): ReasoningDeltaEvent {
  return { type: 'reasoning_delta', delta: event.payload.delta };
}

/** A planned call is the old tool_started boundary. The source DTO requires a
 * durable tool call ID, so a missing wire call ID is unavailable, not synthesized. */
export function legacyToolStarted(
  event: Extract<WireEvent, { readonly type: 'tool_called' }>,
): ToolStartedEvent | undefined {
  const { tool } = event.payload;
  return tool.callId === undefined
    ? undefined
    : {
        type: 'tool_started',
        toolCallId: tool.callId,
        toolName: tool.toolName,
        arguments: structuredClone(tool.input),
      };
}

/** Physical start is the old tool_dispatched boundary; same exact ID requirement. */
export function legacyToolDispatched(
  event: Extract<WireEvent, { readonly type: 'tool_started' }>,
): ToolDispatchedEvent | undefined {
  const { tool } = event.payload;
  return tool.callId === undefined
    ? undefined
    : { type: 'tool_dispatched', toolCallId: tool.callId, toolName: tool.toolName };
}

const RETRY_TYPES = new Set<NonNullable<RetryEvent['retryType']>>([
  'hallucination',
  'parsing_error',
  'behavior',
  'flex_service_tier',
  'upstream',
  'conversation_state',
  'connection_interrupted',
]);
const RETRY_ERROR_KINDS = new Set<NonNullable<RetryEvent['errorKind']>>([
  'network',
  'provider',
  'rate_limit',
  'authentication',
  'cancelled',
  'unknown',
]);

/** Only emit the source retry DTO when the wire actually carries its required
 * toolName/maxRetries and a known retryType; otherwise the record is unavailable. */
export function legacyRetry(event: Extract<WireEvent, { readonly type: 'retrying' }>): RetryEvent | undefined {
  const { attempt, delayMs, error, toolName, maxRetries, retryType, retryAfterMs } = event.payload;
  if (toolName === undefined || maxRetries === undefined) return undefined;
  if (retryType !== undefined && !RETRY_TYPES.has(retryType as NonNullable<RetryEvent['retryType']>)) return undefined;
  const errorKind = RETRY_ERROR_KINDS.has(error.kind as NonNullable<RetryEvent['errorKind']>)
    ? (error.kind as NonNullable<RetryEvent['errorKind']>)
    : undefined;
  return {
    type: 'retry',
    toolName,
    attempt,
    maxRetries,
    errorMessage: error.message,
    ...(retryType !== undefined ? { retryType: retryType as NonNullable<RetryEvent['retryType']> } : {}),
    ...(errorKind !== undefined ? { errorKind } : {}),
    delayMs,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** The accepted budget evidence is already the source RunBudgetEvent shape. */
export function legacyRunBudget(evidence: WireBudgetEvidence): RunBudgetEventNotice {
  return { type: 'run_budget', evidence: structuredClone(evidence) };
}

/** Project the immutable accepted terminal window into the old final DTO. The caller
 * passes command IDs it actually emitted live; those are omitted from final exactly as
 * the old stream did. providerHistory and private provider items are never synthesized. */
export type LegacyFinalResponse = FinalResponseEvent & {
  /** True when a read-only replay rebuilt the window from accepted facts. */
  readonly legacyDerived?: true;
};
export function legacyFinalResponse(
  window: WireFinalWindow,
  emittedCommandMessageIds: ReadonlySet<string>,
  requestId: (nativeId: string) => string = (nativeId) => nativeId,
): LegacyFinalResponse {
  const record = window.record;
  const commandMessages = record.commandMessages.filter((message) => !emittedCommandMessageIds.has(message.id));
  // The old final DTO carried provider-facing result items and completed text,
  // not the durable tool_call admission items. Build a provider result view only
  // when the accepted window proves no private/unrepresentable provider content
  // was omitted; otherwise the public output is not the provider representation.
  type FinalItem = NonNullable<FinalResponseEvent['turnItems']>[number];
  const turnItems = record.turnItems.flatMap<FinalItem>((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const candidate = item as unknown as Record<string, unknown>;
    if (candidate['type'] === 'tool_call') return [];
    if (candidate['type'] !== 'tool_result') return [structuredClone(item) as FinalItem];
    const callId = candidate['callId'];
    const toolName = candidate['toolName'];
    const output = candidate['output'];
    if (
      candidate['providerItem'] !== undefined ||
      window.coverage.items !== 'complete_public_items' ||
      typeof callId !== 'string' ||
      typeof toolName !== 'string' ||
      typeof output !== 'string'
    )
      return [structuredClone(item) as FinalItem];
    return [
      {
        ...structuredClone(item),
        providerItem: { type: 'function_call_result', callId, name: toolName, output },
      } as FinalItem,
    ];
  });
  return {
    type: 'final',
    finalText: record.finalText,
    ...(record.reasoningText !== undefined ? { reasoningText: record.reasoningText } : {}),
    ...(commandMessages.length > 0
      ? { commandMessages: commandMessages.map((message) => structuredClone(message)) }
      : {}),
    ...(record.usage !== undefined ? { usage: legacyUsage(record.usage) } : {}),
    ...(record.costRecords.length > 0
      ? { costRecords: record.costRecords.map((cost) => legacyCostRecord(cost, requestId(cost.requestId))) }
      : {}),
    ...(turnItems.length > 0 ? { turnItems } : {}),
    ...(record.terminalCause !== undefined ? { terminalCause: record.terminalCause } : {}),
    ...(window.derivedFromAcceptedFacts ? { legacyDerived: true as const } : {}),
  };
}

/** Project one actual settled request record through the old public representation:
 * a run-local `req-N` identity, standard tier for an unspecified dispatch, and the
 * old provider-before-model unpriced reason. The accepted native record remains
 * untouched on the wire; no price is invented, so only an unpriced reason may be
 * clarified from the real catalog lookup.
 */
export function legacyRequestCostUpdate(
  event: Extract<WireEvent, { readonly type: 'request_cost_recorded' }>,
  requestId: string = event.payload.record.requestId,
): CostUpdateEvent {
  return { type: 'cost_update', record: legacyCostRecord(event.payload.record, requestId) };
}

/** One live usage observation in the old DTO. Zero cache counters were omitted by
 * the source normalizer; a real zero is not a distinct legacy observation. */
export function legacyUsageUpdate(usage: UsageUpdateEvent['usage']): UsageUpdateEvent {
  return { type: 'usage_update', usage: legacyUsage(usage) };
}

/** Translate the accepted camel-case Usage fact into the old normalized DTO. */
export function legacyAcceptedUsage(usage: WireUsage): UsageUpdateEvent {
  return legacyUsageUpdate({
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== 0 ? { cache_read_tokens: usage.cachedInputTokens } : {}),
    total_tokens: usage.inputTokens + usage.outputTokens,
  });
}

function legacyCostRecord(record: ModelRequestCost, requestId: string): ModelRequestCost {
  const serviceTier = record.serviceTier === 'unknown' ? 'standard' : record.serviceTier;
  const { unpricedReason: nativeReason, usage, ...rest } = record;
  const unpricedReason =
    nativeReason === 'unknown_model' && record.usdMicros === undefined
      ? unresolvedReason(record.provider, record.model, serviceTier) ?? nativeReason
      : nativeReason;
  return {
    ...rest,
    requestId,
    serviceTier,
    ...(usage !== undefined ? { usage: legacyUsage(usage) } : {}),
    ...(unpricedReason !== undefined ? { unpricedReason } : {}),
  };
}

function unresolvedReason(
  provider: string,
  model: string,
  serviceTier: ModelRequestCost['serviceTier'],
): ModelRequestCost['unpricedReason'] | undefined {
  const lookup = getModelPricing(provider, model, serviceTier);
  return !lookup.found && lookup.reason === 'unknown_provider' ? 'unknown_provider' : undefined;
}

function legacyUsage(usage: UsageUpdateEvent['usage']): UsageUpdateEvent['usage'] {
  const next = { ...usage };
  if (next.cache_read_tokens === 0) delete next.cache_read_tokens;
  if (next.cache_creation_tokens === 0) delete next.cache_creation_tokens;
  return next;
}

/** Project only complete source-formatted command DTOs retained in accepted tool
 * display. Missing/foreign display produces no record, never blank success or a
 * fabricated ID/status. Callers retain turn/branch scope and upsert by message ID;
 * this helper does not construct an authoritative final/turn-item window.
 */
export function legacyCommandMessages(
  event: Extract<WireEvent, { readonly type: 'tool_finished' }>,
  options: {
    /** Headless emitted a provider-call-ID view live; the final window retains the
     * accepted display identity and must still be told it was already delivered. */
    readonly providerCallId?: boolean;
    readonly onSourceId?: (id: string) => void;
  } = {},
): CommandMessageEvent[] {
  const display = event.payload.display;
  const messages = Array.isArray(display)
    ? display
    : display && typeof display === 'object' && 'messages' in display
    ? display.messages
    : undefined;
  if (!Array.isArray(messages)) return [];
  return messages.filter(isCommandMessage).map((message) => {
    options.onSourceId?.(message.id);
    return {
      type: 'command_message',
      message:
        options.providerCallId === true
          ? legacyCommandMessage(message, event.payload.callId)
          : structuredClone(message),
    };
  });
}

/** The source display uses its own direct execution call ID; the legacy DTO used
 * the provider-visible call ID for the same command. Keep the command identity,
 * and only rewrite the exact `direct:<uuid>` display namespace (never guess a
 * foreign tool's ID). */
function legacyCommandMessage(message: CommandMessage, providerCallId: string | undefined): CommandMessage {
  const copy = structuredClone(message);
  if (providerCallId === undefined || typeof copy.callId !== 'string' || !copy.callId.startsWith('direct:'))
    return copy;
  const prefix = `${copy.callId}-`;
  return {
    ...copy,
    callId: providerCallId,
    ...(copy.id.startsWith(prefix) ? { id: `${providerCallId}-${copy.id.slice(prefix.length)}` } : {}),
  };
}

/** Recognize the existing source DTO, not arbitrary tool output or presentation. */
function isCommandMessage(value: unknown): value is CommandMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === 'string' &&
    message.sender === 'command' &&
    typeof message.command === 'string' &&
    typeof message.output === 'string' &&
    ['pending', 'running', 'completed', 'failed', 'aborted', 'unknown'].some((status) => status === message.status) &&
    ['success', 'isApprovalRejection', 'autoApprovedByLlm'].every(
      (key) => message[key] === undefined || typeof message[key] === 'boolean',
    ) &&
    ['failureReason', 'toolName', 'callId'].every(
      (key) => message[key] === undefined || typeof message[key] === 'string',
    )
  );
}

/** Emit only the old actual count/name DTO. Producing turn/step/call/branch scope
 * stays in the wire envelope; no raw delta or finalized call is reconstructed.
 */
export function legacyToolCallStreamingDelta(
  event: Extract<WireEvent, { readonly type: 'tool_call_streaming_delta' }>,
): ToolCallStreamingDeltaEvent {
  return {
    type: 'tool_call_streaming_delta',
    ...(event.payload.toolName !== undefined ? { toolName: event.payload.toolName } : {}),
    argumentCharCount: event.payload.argumentCharCount,
  };
}
