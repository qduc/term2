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

  const raw = asRecord(record.rawItem) ?? record;
  const callId = raw.callId ?? raw.call_id ?? raw.tool_call_id;
  return typeof callId === 'string' && callId ? callId : null;
};

export type ChainedModelInputFilterOptions = {
  toolResultCallIds?: readonly string[];
};

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

export const filterChainedModelInput = (modelData: any, options: ChainedModelInputFilterOptions = {}): any => {
  const input = modelData?.input;
  if (!Array.isArray(input) || input.length <= 1) {
    return modelData;
  }

  const expectedToolResultCallIds = new Set(options.toolResultCallIds?.filter(Boolean) ?? []);
  if (expectedToolResultCallIds.size > 0) {
    const expectedToolResults = input.filter((item) => {
      const callId = getToolResultCallId(item);
      return callId !== null && expectedToolResultCallIds.has(callId);
    });

    if (expectedToolResults.length > 0) {
      return {
        ...modelData,
        input: expectedToolResults,
      };
    }
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
