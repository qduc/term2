import deepEqual from 'fast-deep-equal';

type RecordValue = Record<string, unknown>;

export type ResponsesLiteWireStateKey = string;

type PendingRequest = {
  fingerprint: string;
  input: unknown[];
};

type StoredRequest = PendingRequest & {
  responseId: string;
  outputItems: unknown[];
};

export type PreparedResponsesLiteRequest = {
  requestData: RecordValue;
  usedDelta: boolean;
};

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isAdditionalTools = (value: unknown): value is RecordValue =>
  isRecord(value) && value.type === 'additional_tools' && value.role === 'developer';

const isDeveloperMessage = (value: unknown): value is RecordValue =>
  isRecord(value) && value.type === 'message' && value.role === 'developer';

const REPLAY_ITEM_TYPES_WITHOUT_IDS = new Set([
  'message',
  'local_shell_call',
  'function_call',
  'tool_search_call',
  'custom_tool_call',
  'web_search_call',
]);

function normalizeReplayItems(items: unknown[]): unknown[] {
  return items.map((item) => {
    if (!isRecord(item) || typeof item.type !== 'string' || !REPLAY_ITEM_TYPES_WITHOUT_IDS.has(item.type)) {
      return item;
    }

    const { id: _id, ...withoutId } = item;
    return withoutId;
  });
}

function getPrefix(input: unknown[]): unknown[] {
  if (!isAdditionalTools(input[0])) {
    return [];
  }

  const prefix = [input[0]];
  if (isDeveloperMessage(input[1])) {
    prefix.push(input[1]);
  }
  return prefix;
}

function getComparableRequest(requestData: RecordValue): RecordValue {
  const {
    input: _input,
    previous_response_id: _previousResponseId,
    client_metadata: _clientMetadata,
    generate: _generate,
    ...rest
  } = requestData;
  return rest;
}

function getFingerprint(requestData: RecordValue, input: unknown[]): string {
  return JSON.stringify({ request: getComparableRequest(requestData), prefix: getPrefix(input) });
}

function startsWith(input: unknown[], prefix: unknown[]): boolean {
  if (prefix.length > input.length) {
    return false;
  }

  return prefix.every((item, index) => deepEqual(item, input[index]));
}

function getPreviousResponseId(requestData: RecordValue): string | undefined {
  return typeof requestData.previous_response_id === 'string' && requestData.previous_response_id.length > 0
    ? requestData.previous_response_id
    : undefined;
}

/**
 * Keeps Responses-Lite's canonical request separate from the smaller payload
 * sent over a reused WebSocket response chain.
 *
 * The caller may provide either the full logical input or the server-managed
 * delta supplied by the Agents SDK. Strict baseline matching is preferred;
 * prefix matching is the safe fallback for requests whose older history is
 * already held by the provider.
 */
export class ResponsesLiteWireState {
  private readonly stored = new Map<ResponsesLiteWireStateKey, StoredRequest>();
  private readonly pending = new Map<ResponsesLiteWireStateKey, PendingRequest>();

  prepare(key: ResponsesLiteWireStateKey, requestData: RecordValue): PreparedResponsesLiteRequest {
    const input = Array.isArray(requestData.input) ? requestData.input : [];
    const fingerprint = getFingerprint(requestData, input);
    this.pending.set(key, { fingerprint, input: [...input] });

    const previousResponseId = getPreviousResponseId(requestData);
    const stored = this.stored.get(key);
    if (!stored || !previousResponseId || stored.responseId !== previousResponseId) {
      return { requestData, usedDelta: false };
    }

    if (stored.fingerprint !== fingerprint) {
      return { requestData, usedDelta: false };
    }

    const baseline = [...stored.input, ...stored.outputItems];
    const prefix = getPrefix(input);
    const delta = startsWith(input, baseline)
      ? input.slice(baseline.length)
      : startsWith(input, prefix)
      ? input.slice(prefix.length)
      : null;

    if (delta === null) {
      return { requestData, usedDelta: false };
    }

    return {
      requestData: { ...requestData, input: delta },
      usedDelta: true,
    };
  }

  recordResponse(key: ResponsesLiteWireStateKey, responseId: string, outputItems: unknown[]): void {
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }

    this.stored.set(key, {
      ...pending,
      responseId,
      outputItems: Array.isArray(outputItems) ? normalizeReplayItems(outputItems) : [],
    });
    this.pending.delete(key);
  }

  invalidate(key: ResponsesLiteWireStateKey): void {
    this.stored.delete(key);
    this.pending.delete(key);
  }

  clear(): void {
    this.stored.clear();
    this.pending.clear();
  }
}
