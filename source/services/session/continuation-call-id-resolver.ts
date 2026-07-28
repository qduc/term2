import { asRecord, getCallIdFromObject } from '../interruption-info.js';
import { getToolCallId } from '../../lib/chained-input-filter.js';

const addCallId = (callIds: Set<string>, value: unknown): void => {
  if (typeof value === 'string' && value.length > 0) {
    callIds.add(value);
  }
};

export type ResponseCycleCallIdResolutionInput = {
  interruptionCallIds: readonly string[];
  completedResultCallIds: readonly string[];
  fallbackCallIds: readonly string[];
  conversationHistory: readonly unknown[];
  preserveFallback?: boolean;
};

/**
 * Resolves the tool-result IDs required to resume the current response cycle.
 *
 * The turn workflow provides IDs from RunState's public interruption API and
 * the session-owned current-turn tool ledger.
 */
export const resolveResponseCycleCallIds = ({
  interruptionCallIds,
  completedResultCallIds,
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

  for (const callId of interruptionCallIds) {
    addCallId(callIds, callId);
  }

  const consumedCallIds = new Set<string>();
  for (const item of conversationHistory) {
    const record = asRecord(item);
    const type = record?.type;
    if (type !== 'function_call' && type !== 'tool_call') {
      addCallId(consumedCallIds, getCallIdFromObject(item));
    }
  }

  for (const callId of completedResultCallIds) {
    if (!consumedCallIds.has(callId)) {
      addCallId(callIds, callId);
    }
  }

  return callIds.size > 0 ? [...callIds] : [...fallbackCallIds];
};

/**
 * Collects the tool-call ids known to the current provider response chain.
 *
 * Terminal turns contribute calls through conversation history. Interrupted
 * turns have not committed their generated items yet, so their calls must come
 * from the session-owned current-turn ledger.
 */
export const collectKnownToolCallIds = (
  conversationHistory: readonly unknown[],
  currentTurnCallIds: readonly string[] = [],
): string[] => {
  const callIds = new Set<string>();
  for (const item of conversationHistory) {
    // Any `*_call` item counts — function calls, shell calls, computer calls —
    // so a non-function tool is never mistaken for an orphan.
    addCallId(callIds, getToolCallId(item));
  }
  for (const callId of currentTurnCallIds) {
    addCallId(callIds, callId);
  }
  return [...callIds];
};

export type AbortedApprovalCallIdResolutionInput = {
  interruptionCallIds: readonly string[];
  completedResultCallIds: readonly string[];
};

/** Resolves tool-result IDs that must be replayed while resolving an aborted approval. */
export const resolveAbortedApprovalCallIds = ({
  interruptionCallIds,
  completedResultCallIds,
}: AbortedApprovalCallIdResolutionInput): string[] => {
  const callIds = new Set<string>();
  for (const callId of interruptionCallIds) {
    addCallId(callIds, callId);
  }

  for (const callId of completedResultCallIds) {
    addCallId(callIds, callId);
  }

  return [...callIds];
};
