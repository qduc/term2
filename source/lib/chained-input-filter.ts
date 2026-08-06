import { normalizeRunItem } from '../services/conversation/run-item-normalizer.js';

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const isUserInputMessage = (item: unknown): boolean => {
  const record = asRecord(item);
  return record?.role === 'user';
};

export const isToolResultItem = (item: unknown): boolean => {
  return normalizeRunItem(item).some((normalized) => normalized.type === 'tool_result');
};

const getExplicitToolCallId = (item: unknown): string | null => {
  const outer = asRecord(item);
  const raw = asRecord(outer?.rawItem);
  for (const record of [outer, raw]) {
    const callId = record?.callId ?? record?.call_id ?? record?.tool_call_id ?? record?.toolCallId;
    if (typeof callId === 'string' && callId) {
      return callId;
    }
  }
  return null;
};

export const getToolResultCallId = (item: unknown): string | null => {
  const result = normalizeRunItem(item).find((normalized) => normalized.type === 'tool_result');
  return result ? getExplicitToolCallId(item) : null;
};

/**
 * Extracts the call id of a tool *call* item (`function_call`, `local_shell_call`,
 * `computer_call`, …). Returns null for tool results and for items that are not
 * tool calls at all.
 */
export const getToolCallId = (item: unknown): string | null => {
  const call = normalizeRunItem(item).find((normalized) => normalized.type === 'tool_call');
  if (call) {
    return getExplicitToolCallId(item);
  }

  // Keep the filter's legacy provider-extension compatibility narrow and local.
  // The canonical normalizer deliberately does not classify every `*_call` item:
  // hosted calls such as image generation are provider items, not tool-ledger calls.
  const outer = asRecord(item);
  const raw = asRecord(outer?.rawItem);
  const type = typeof outer?.type === 'string' ? outer.type : typeof raw?.type === 'string' ? raw.type : '';
  return type.endsWith('_call') ? getExplicitToolCallId(item) : null;
};

export type ChainedModelInputFilterOptions = {
  toolResultCallIds?: readonly string[];
  /**
   * Tool-call ids the response chain is known to hold, supplied by the caller
   * that owns the conversation history. A pre-trimmed delta carries no calls of
   * its own, so without this the orphan check has nothing to match against and
   * abstains.
   */
  knownToolCallIds?: readonly string[];
};

export class MissingChainedToolOutputError extends Error {
  readonly callIds: string[];

  constructor(callIds: readonly string[]) {
    super(`Chained continuation is missing required tool output(s): ${callIds.join(', ')}`);
    this.name = 'MissingChainedToolOutputError';
    this.callIds = [...callIds];
  }
}

export const isMissingChainedToolOutputError = (error: unknown): error is MissingChainedToolOutputError =>
  error instanceof MissingChainedToolOutputError ||
  (asRecord(error)?.name === 'MissingChainedToolOutputError' && Array.isArray(asRecord(error)?.callIds));

/**
 * Raised when a chained delta would carry a `function_call_output` whose
 * `function_call` exists in neither the outgoing input nor — by extension —
 * the response chain the request is anchored to.
 *
 * The provider rejects such a request with `No tool call found for function
 * call output with call_id ...`, so failing here lets recovery rebuild the
 * chain instead of spending a round trip on a guaranteed 400.
 */
export class OrphanedChainedToolOutputError extends Error {
  readonly callIds: string[];

  constructor(callIds: readonly string[]) {
    super(`Chained continuation has tool output(s) with no matching tool call: ${callIds.join(', ')}`);
    this.name = 'OrphanedChainedToolOutputError';
    this.callIds = [...callIds];
  }
}

export const isOrphanedChainedToolOutputError = (error: unknown): error is OrphanedChainedToolOutputError =>
  error instanceof OrphanedChainedToolOutputError ||
  (asRecord(error)?.name === 'OrphanedChainedToolOutputError' && Array.isArray(asRecord(error)?.callIds));

/**
 * Finds the starting index of the delta input when conversation chaining is active.
 *
 * Assumption: Deltas are expected to be either:
 *  (a) trailing tool results (when the model has just called tools and is continuing), or
 *  (b) a new user message plus everything after it (when starting a new turn).
 *
 * If the input ends with a replayed assistant message that follows a tool output,
 * this function falls back to searching for the last user message, which may over-retain.
 * In practice, this is rare because model invocations are typically triggered by new user
 * inputs or new tool results.
 */
export const findChainedDeltaStart = (input: unknown[]): number => {
  let endUserIndex = input.length;
  while (endUserIndex > 0 && isUserInputMessage(input[endUserIndex - 1])) {
    endUserIndex--;
  }

  if (endUserIndex > 0 && isToolResultItem(input[endUserIndex - 1])) {
    let toolStart = endUserIndex;
    while (toolStart > 0 && isToolResultItem(input[toolStart - 1])) {
      toolStart--;
    }
    return toolStart;
  }

  for (let index = input.length - 1; index >= 0; index--) {
    if (isUserInputMessage(input[index])) {
      return index;
    }
  }

  return 0;
};

/**
 * Guards the `toolResultCallIds` shortcut, which sends the selected tool
 * outputs alone and relies on the response chain already holding their calls.
 *
 * A call counts as present when it appears in the input itself or in
 * `knownToolCallIds`, the ids the caller knows the chain anchor holds. When
 * neither source offers a single call id there is nothing to match against, so
 * the check abstains rather than rejecting a delta it cannot judge.
 */
const assertToolResultsHaveMatchingCalls = (
  input: unknown[],
  expectedToolResults: unknown[],
  knownToolCallIds: readonly string[],
): void => {
  const knownCallIds = new Set<string>(knownToolCallIds.filter(Boolean));
  for (const item of input) {
    const callId = getToolCallId(item);
    if (callId) {
      knownCallIds.add(callId);
    }
  }

  if (knownCallIds.size === 0) {
    return;
  }

  const orphaned = new Set<string>();
  for (const item of expectedToolResults) {
    const callId = getToolResultCallId(item);
    if (callId && !knownCallIds.has(callId)) {
      orphaned.add(callId);
    }
  }

  if (orphaned.size > 0) {
    throw new OrphanedChainedToolOutputError([...orphaned]);
  }
};

export const filterChainedModelInput = (modelData: any, options: ChainedModelInputFilterOptions = {}): any => {
  const input = modelData?.input;
  if (!Array.isArray(input)) {
    return modelData;
  }

  const expectedToolResultCallIds = new Set(options.toolResultCallIds?.filter(Boolean) ?? []);
  if (expectedToolResultCallIds.size > 0) {
    const expectedToolResults = input.filter((item) => {
      const callId = getToolResultCallId(item);
      return callId !== null && expectedToolResultCallIds.has(callId);
    });

    if (expectedToolResults.length > 0) {
      assertToolResultsHaveMatchingCalls(input, expectedToolResults, options.knownToolCallIds ?? []);
      return {
        ...modelData,
        input: expectedToolResults,
      };
    }

    if (input.length === 0) {
      throw new MissingChainedToolOutputError([...expectedToolResultCallIds]);
    }
  }

  if (input.length <= 1) {
    return modelData;
  }

  const deltaStart = findChainedDeltaStart(input);
  if (deltaStart <= 0) {
    return modelData;
  }

  return {
    ...modelData,
    input: input.slice(deltaStart),
  };
};
