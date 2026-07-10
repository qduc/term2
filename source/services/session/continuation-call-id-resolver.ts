import { asRecord, getCallIdFromObject, getMethod } from '../interruption-info.js';
import { callIdOf } from '../tool-execution-ledger.js';

const CONTINUATION_TOOL_RESULT_TYPES = new Set([
  'function_call_result',
  'function_call_output',
  'function_call_output_result',
  'tool_call_output_item',
]);

const addCallId = (callIds: Set<string>, value: unknown): void => {
  if (typeof value === 'string' && value.length > 0) {
    callIds.add(value);
  }
};

const getGeneratedToolResultCallIds = (
  runState: unknown,
  consumedCallIds: ReadonlySet<string> = new Set(),
): string[] => {
  const generatedItems = asRecord(runState)?._generatedItems;
  if (!Array.isArray(generatedItems)) {
    return [];
  }

  const callIds = new Set<string>();
  for (const item of generatedItems) {
    const raw = asRecord(item)?.rawItem;
    const typeSource = asRecord(raw) ?? asRecord(item);
    const type = typeof typeSource?.type === 'string' ? typeSource.type : '';
    if (!CONTINUATION_TOOL_RESULT_TYPES.has(type)) {
      continue;
    }

    const callId = callIdOf(item);
    if (callId && !consumedCallIds.has(callId)) {
      callIds.add(callId);
    }
  }

  return [...callIds];
};

export type ResponseCycleCallIdResolutionInput = {
  runState: unknown;
  primaryInterruption: unknown;
  fallbackCallIds: readonly string[];
  conversationHistory: readonly unknown[];
  preserveFallback?: boolean;
};

/**
 * Resolves the tool-result IDs required to resume the current response cycle.
 *
 * The SDK keeps some completed tool outputs in its private generated-item
 * state. This boundary contains that shape interpretation so the turn
 * workflow only has to provide the current run state and conversation history.
 */
export const resolveResponseCycleCallIds = ({
  runState,
  primaryInterruption,
  fallbackCallIds,
  conversationHistory,
  preserveFallback = false,
}: ResponseCycleCallIdResolutionInput): string[] => {
  const callIds = new Set<string>();

  if (preserveFallback) {
    for (const callId of fallbackCallIds) {
      addCallId(callIds, callId);
    }
  }

  const interruptions = getMethod<[], unknown>(runState, 'getInterruptions')?.();
  if (Array.isArray(interruptions)) {
    for (const interruption of interruptions) {
      addCallId(callIds, getCallIdFromObject(interruption));
    }
  }

  const consumedCallIds = new Set<string>();
  for (const item of conversationHistory) {
    const record = asRecord(item);
    const type = record?.type;
    if (type !== 'function_call' && type !== 'tool_call') {
      addCallId(consumedCallIds, getCallIdFromObject(item));
    }
  }

  for (const callId of getGeneratedToolResultCallIds(runState, consumedCallIds)) {
    addCallId(callIds, callId);
  }

  addCallId(callIds, getCallIdFromObject(primaryInterruption));

  return callIds.size > 0 ? [...callIds] : [...fallbackCallIds];
};

export type AbortedApprovalCallIdResolutionInput = {
  runState: unknown;
  primaryInterruption: unknown;
};

/** Resolves tool-result IDs that must be replayed while resolving an aborted approval. */
export const resolveAbortedApprovalCallIds = ({
  runState,
  primaryInterruption,
}: AbortedApprovalCallIdResolutionInput): string[] => {
  const callIds = new Set<string>();
  const interruptions = getMethod<[], unknown>(runState, 'getInterruptions')?.();
  if (Array.isArray(interruptions)) {
    for (const interruption of interruptions) {
      addCallId(callIds, getCallIdFromObject(interruption));
    }
  }

  for (const callId of getGeneratedToolResultCallIds(runState)) {
    addCallId(callIds, callId);
  }

  addCallId(callIds, getCallIdFromObject(primaryInterruption));
  return [...callIds];
};
