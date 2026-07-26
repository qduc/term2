export const TOOL_RESULT_ITEM_TYPES = new Set([
  'function_call_output',
  'function_call_result',
  'function_call_output_result',
  'tool_call_output',
  'tool_call_result',
  'tool_call_output_item',
  'local_shell_call_output',
  'shell_call_output',
  'computer_call_output',
  'computer_call_result',
  'apply_patch_call_output',
]);

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const isUserInputMessage = (item: unknown): boolean => {
  const record = asRecord(item);
  return record?.role === 'user';
};

export const isToolResultItem = (item: unknown): boolean => {
  const record = asRecord(item);
  return typeof record?.type === 'string' && TOOL_RESULT_ITEM_TYPES.has(record.type);
};

export const getToolResultCallId = (item: unknown): string | null => {
  const record = asRecord(item);
  if (!record || !isToolResultItem(record)) {
    return null;
  }

  const topLevelCallId = record.callId ?? record.call_id ?? record.tool_call_id;
  if (typeof topLevelCallId === 'string' && topLevelCallId) {
    return topLevelCallId;
  }

  const raw = asRecord(record.rawItem);
  if (!raw) {
    return null;
  }

  const callId = raw.callId ?? raw.call_id ?? raw.tool_call_id;
  return typeof callId === 'string' && callId ? callId : null;
};

/**
 * Extracts the call id of a tool *call* item (`function_call`, `local_shell_call`,
 * `computer_call`, …). Returns null for tool results and for items that are not
 * tool calls at all.
 */
export const getToolCallId = (item: unknown): string | null => {
  const record = asRecord(item);
  if (!record || isToolResultItem(record)) {
    return null;
  }

  const type = typeof record.type === 'string' ? record.type : '';
  if (!type.endsWith('_call')) {
    return null;
  }

  const topLevelCallId = record.callId ?? record.call_id ?? record.tool_call_id;
  if (typeof topLevelCallId === 'string' && topLevelCallId) {
    return topLevelCallId;
  }

  const raw = asRecord(record.rawItem);
  if (!raw) {
    return null;
  }

  const callId = raw.callId ?? raw.call_id ?? raw.tool_call_id;
  return typeof callId === 'string' && callId ? callId : null;
};

export type ChainedModelInputFilterOptions = {
  toolResultCallIds?: readonly string[];
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
  let trailingToolResultStart = input.length;
  while (trailingToolResultStart > 0 && isToolResultItem(input[trailingToolResultStart - 1])) {
    trailingToolResultStart--;
  }
  if (trailingToolResultStart < input.length) {
    return trailingToolResultStart;
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
 * The check only applies when the input is a full item list (it carries tool
 * calls of its own). A caller that hands over an already-trimmed delta has no
 * calls to match against, and their absence says nothing about the chain.
 */
const assertToolResultsHaveMatchingCalls = (input: unknown[], expectedToolResults: unknown[]): void => {
  const callIdsInInput = new Set<string>();
  for (const item of input) {
    const callId = getToolCallId(item);
    if (callId) {
      callIdsInInput.add(callId);
    }
  }

  if (callIdsInInput.size === 0) {
    return;
  }

  const orphaned = new Set<string>();
  for (const item of expectedToolResults) {
    const callId = getToolResultCallId(item);
    if (callId && !callIdsInInput.has(callId)) {
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
      assertToolResultsHaveMatchingCalls(input, expectedToolResults);
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
