import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';
import { getCurrentTrace, withTrace } from '@openai/agents-core';
import { randomUUID } from 'node:crypto';
import { sanitizeHeaders } from '../utils/header-sanitizer.js';
import type { ISessionContextService, IProviderTraffic } from '../services/service-interfaces.js';
import { dropUnpairedFunctionCalls } from '../services/tool-execution-ledger.js';
import { ChainedWireState, type ChainedWireStateKey, type ChainedRequestToken } from './chained-wire-state.js';
import { LunaResponsesLiteWireProtocol } from './luna-responses-lite-wire-protocol.js';
import {
  createWebSocketReceiveWatchdog,
  DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS,
  type WebSocketReceiveTimeouts,
} from './websocket-receive-watchdog.js';

const DUMMY_PROVIDER_TRAFFIC: IProviderTraffic = {
  recordRequestStart() {},
  async recordResponseReceived() {},
  recordRequestFailed() {},
};
import {
  isPreviousResponseNotFoundError,
  isRetryableTransportError,
} from '../services/retry/retry-error-classification.js';

type DiagnosticLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

const SUSPICIOUS_RECONSTRUCTED_OUTPUT_ITEM_COUNT = 20;
const TERMINAL_RESPONSE_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.error',
]);

const WS_RESPONSE_MODEL_CLASS = 'OpenAIResponsesWSModel';
const WS_RESPONSE_WRAPPER_CLASS = 'CodexResponsesWSModel';
const RESPONSES_LITE_MODELS = new Set(['gpt-5.6-luna']);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringValue = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const CODEX_REPLAY_ITEM_TYPES_WITHOUT_IDS = new Set([
  'message',
  'reasoning',
  'local_shell_call',
  'function_call',
  'tool_search_call',
  'custom_tool_call',
  'web_search_call',
]);

function stripCodexReplayIds(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }

  let changed = false;
  const normalized = input.map((item) => {
    const record = asRecord(item);
    const type = stringValue(record?.type);
    if (!record || !type || !CODEX_REPLAY_ITEM_TYPES_WITHOUT_IDS.has(type) || !('id' in record)) {
      return item;
    }

    const { id: _id, ...rest } = record;
    changed = true;
    return rest;
  });

  return changed ? normalized : input;
}

function normalizeCodexRequestData(
  requestData: any,
  request: any,
  model: string,
  options: { includeDeveloperInstructionsOnChainedRequest?: boolean } = {},
): any {
  const normalizedRequestData = { ...requestData };

  // Codex responses endpoint rejects temperature; always omit it.
  if ('temperature' in normalizedRequestData) {
    delete normalizedRequestData.temperature;
  }

  const hasPreviousResponseId =
    (typeof normalizedRequestData.previous_response_id === 'string' &&
      normalizedRequestData.previous_response_id.length > 0) ||
    (typeof request?.previousResponseId === 'string' && request.previousResponseId.length > 0);
  const normalizedInput =
    !hasPreviousResponseId && Array.isArray(normalizedRequestData.input)
      ? dropUnpairedFunctionCalls(normalizedRequestData.input)
      : normalizedRequestData.input;
  normalizedRequestData.input = stripCodexReplayIds(normalizedInput);

  const modelInclude = request?.modelSettings?.include;
  if (Array.isArray(modelInclude) && modelInclude.length > 0) {
    const existingInclude = Array.isArray(normalizedRequestData.include) ? normalizedRequestData.include : [];
    normalizedRequestData.include = Array.from(
      new Set([...existingInclude, ...modelInclude].filter((entry) => typeof entry === 'string' && entry.length > 0)),
    );
  }

  const promptCacheKey = request?.modelSettings?.prompt_cache_key;
  if (typeof promptCacheKey === 'string' && promptCacheKey.length > 0) {
    normalizedRequestData.prompt_cache_key = promptCacheKey;
  }

  if (RESPONSES_LITE_MODELS.has(normalizedRequestData.model ?? model)) {
    const prefix: any[] = [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: normalizedRequestData.tools ?? [],
      },
    ];
    if (
      (options.includeDeveloperInstructionsOnChainedRequest || !hasPreviousResponseId) &&
      typeof normalizedRequestData.instructions === 'string' &&
      normalizedRequestData.instructions.length > 0
    ) {
      prefix.push({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: normalizedRequestData.instructions }],
      });
    }
    normalizedRequestData.input = [...prefix, ...(normalizedRequestData.input ?? [])];
    normalizedRequestData.instructions = '';
    delete normalizedRequestData.tools;
    normalizedRequestData.parallel_tool_calls = false;
    normalizedRequestData.reasoning = {
      ...(asRecord(normalizedRequestData.reasoning) ?? {}),
      context: 'all_turns',
    };
    normalizedRequestData.client_metadata = {
      ...normalizedRequestData.client_metadata,
      'x-openai-internal-codex-responses-lite': 'true',
    };
  }

  return normalizedRequestData;
}

const summarizeReconstructedItems = (items: unknown[]): Record<string, unknown> => {
  const typeCounts: Record<string, number> = {};
  let functionCallCount = 0;

  for (const item of items) {
    const record = asRecord(item);
    const type = stringValue(record?.type) ?? 'unknown';
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    if (type === 'function_call') {
      functionCallCount++;
    }
  }

  const first = asRecord(items[0]);
  const last = asRecord(items[items.length - 1]);
  return {
    itemCount: items.length,
    typeCounts,
    functionCallCount,
    firstItemType: stringValue(first?.type),
    firstItemId: stringValue(first?.id),
    firstItemCallId: stringValue(first?.call_id) ?? stringValue(first?.callId),
    lastItemType: stringValue(last?.type),
    lastItemId: stringValue(last?.id),
    lastItemCallId: stringValue(last?.call_id) ?? stringValue(last?.callId),
  };
};

// Codex's `/backend-api/codex/responses` endpoint can ship terminal response
// frames with either an empty `output` array or no `output` field at all, even
// when the assistant message was already delivered via
// `response.output_item.done`. The agents-SDK runner trusts terminal
// `response.output` as the final output; when it is empty or missing it either
// sees no items and re-runs the same request until maxTurns or crashes while
// converting the terminal payload.
//
// This wrapper subclasses `OpenAIResponsesModel`, overrides the streaming
// fetch path, and patches the terminal frame in flight: it accumulates raw
// items from `response.output_item.done` and, only when terminal
// `response.output` is empty or missing, swaps in the accumulated items so the
// parent's existing conversion logic (`convertToOutputItem`) produces a normal
// `response_done` event.
const CODEX_SERVER_HISTORY_TOOL_RESULT_TYPES = new Set([
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

type CodexServerHistoryItem = {
  type?: string;
  itemId?: string;
  callId?: string;
  isFunctionCall: boolean;
  isToolResult: boolean;
};

const normalizeCodexServerHistoryItem = (item: unknown): CodexServerHistoryItem => {
  const record = asRecord(item);
  const type = stringValue(record?.type);
  const itemId = stringValue(record?.id);
  const callId = stringValue(record?.call_id) ?? stringValue(record?.callId) ?? stringValue(record?.tool_call_id);

  return {
    type,
    itemId,
    callId,
    isFunctionCall: type === 'function_call',
    isToolResult: typeof type === 'string' && CODEX_SERVER_HISTORY_TOOL_RESULT_TYPES.has(type),
  };
};

const isUserInputMessage = (item: unknown): boolean => asRecord(item)?.role === 'user';

const isToolResultItem = (item: unknown): boolean => normalizeCodexServerHistoryItem(item).isToolResult;

const hasToolResultInput = (request: any): boolean =>
  Array.isArray(request?.input) && request.input.some((item: unknown) => isToolResultItem(item));

const getToolResultCallId = (item: unknown): string | undefined => {
  const normalized = normalizeCodexServerHistoryItem(item);
  return normalized.isToolResult ? normalized.callId : undefined;
};

const isToolContinuationItem = (item: unknown): boolean => {
  const normalized = normalizeCodexServerHistoryItem(item);
  if (normalized.isToolResult || normalized.callId) {
    return true;
  }

  // Some Codex websocket function_call items arrive in reconstructed history
  // with only their Responses item id (`fc_...`) even though their paired
  // outputs carry the separate `call_...` invocation id. Treat those calls as
  // part of the paired continuation region so earlier parallel outputs are not
  // trimmed away.
  return normalized.isFunctionCall && Boolean(normalized.itemId);
};

const findServerManagedDeltaStart = (input: unknown[]): number => {
  let trailingToolResultStart = input.length;
  // Walk backward through tool-continuation items (tool results and
  // their interleaved function calls) so parallel outputs from the same
  // model response stay together in the delta instead of leaking into
  // the warmup. Items without a call id (user messages, assistant
  // messages, reasoning) naturally stop the walk.
  while (trailingToolResultStart > 0 && isToolContinuationItem(input[trailingToolResultStart - 1])) {
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

const filterConsumedToolResults = (items: unknown[], consumedToolResultCallIds?: ReadonlySet<string>): unknown[] => {
  if (!consumedToolResultCallIds || consumedToolResultCallIds.size === 0) {
    return items;
  }

  return items.filter((item) => {
    const callId = getToolResultCallId(item);
    return !callId || !consumedToolResultCallIds.has(callId);
  });
};

const collectToolResultCallIds = (input: unknown): string[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  const ids: string[] = [];
  for (const item of input) {
    const callId = getToolResultCallId(item);
    if (callId) {
      ids.push(callId);
    }
  }
  return ids;
};

const filterServerManagedInput = (input: unknown, consumedToolResultCallIds?: ReadonlySet<string>): unknown => {
  if (!Array.isArray(input)) {
    return input;
  }
  if (input.length <= 1) {
    return input.length === 1 && isToolResultItem(input[0])
      ? filterConsumedToolResults(input, consumedToolResultCallIds)
      : input;
  }

  // When previous_response_id is reused, the server already holds the
  // previous response's output items (assistant message, reasoning, and the
  // function calls it issued). The request only needs the *new* items
  // produced since then.

  // Tool continuation: the input ends with a tool-call output answering the
  // previous response's function call(s). A previous response may issue
  // several parallel calls, and the reconstructed history pairs each call
  // with its result (fc₁,fco₁,fc₂,fco₂,…) instead of grouping every output
  // in one trailing block. Collect EVERY trailing tool-result item — walking
  // back across tool results and their interleaved function calls (everything
  // carrying a call id) — so the outputs for the earlier parallel calls are
  // not dropped. Stopping at the first interleaved function call would send
  // only the trailing output and the server rejects the request with a 400
  // ("No tool output found for function call …"). The interleaved
  // function-call items are then dropped because the server already holds
  // them via previous_response_id.
  if (isToolResultItem(input[input.length - 1])) {
    let start = input.length - 1;
    while (start > 0 && isToolContinuationItem(input[start - 1])) {
      start--;
    }
    const trailing = input.slice(start);
    // A clean run of tool results (grouped layout) needs no filtering; for
    // the paired layout, drop the interleaved function-call items.
    const toolResults = trailing.every(isToolResultItem) ? trailing : trailing.filter(isToolResultItem);
    return filterConsumedToolResults(toolResults, consumedToolResultCallIds);
  }

  // Fresh user turn with no trailing tool output: the delta is the latest
  // user message onward.
  const deltaStart = findServerManagedDeltaStart(input);
  return deltaStart > 0 ? input.slice(deltaStart) : input;
};

const getResponseIdFromResponse = (response: unknown): string | undefined => {
  const record = asRecord(response);
  const responseId = record?.responseId ?? record?.id;
  return typeof responseId === 'string' && responseId.length > 0 ? responseId : undefined;
};

const getResponseIdFromStreamEvent = (event: unknown): string | undefined => {
  const record = asRecord(event);
  if (record?.type !== 'response_done') {
    return undefined;
  }

  return getResponseIdFromResponse(record.response) ?? getResponseIdFromResponse(record);
};

const getErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '');
  }
  return '';
};

const isPreviousResponseUnavailableError = (error: unknown): boolean => {
  const message = getErrorMessage(error);
  return isPreviousResponseNotFoundError(error) || message.includes('previous_response_not_found');
};

const hasGenerateFalse = (request: any): boolean =>
  (request.modelSettings?.providerData as Record<string, unknown> | undefined)?.generate === false;

const withProviderData = (request: any, providerData: Record<string, unknown>): any => ({
  ...request,
  modelSettings: {
    ...request.modelSettings,
    providerData: {
      ...request.modelSettings?.providerData,
      ...providerData,
    },
  },
});

type PreparedCodexRequest = {
  request: any;
  warmupRequest?: any;
};

type CodexWebSocketIdentity = {
  sessionId: string;
  threadId: string;
  turnId: string;
  windowId: string;
  turnMetadata: string;
  clientMetadata: Record<string, string>;
  headers: Record<string, string>;
};

export class CodexResponsesWSModel extends OpenAIResponsesWSModel {
  private readonly codexPreviousResponseIds = new Map<string, string>();
  private readonly codexConsumedToolResultCallIdsByResponseId = new Map<string, Set<string>>();
  private readonly codexTurnIdsBySession = new Map<string, string>();
  #serverHistoryReuseDisabled = false;

  private readonly providerTraffic: IProviderTraffic;
  private readonly chainedWireState = new ChainedWireState(new LunaResponsesLiteWireProtocol());
  private readonly requestTokens = new WeakMap<object, ChainedRequestToken>();

  constructor(
    client: any,
    private readonly modelId: string,
    private readonly tokenManager: any,
    private readonly diagnosticLogger?: DiagnosticLogger,
    providerTraffic?: IProviderTraffic,
    private readonly sessionContextService?: ISessionContextService,
    private readonly websocketReceiveTimeouts: WebSocketReceiveTimeouts = DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS,
  ) {
    super(client, modelId);
    this.providerTraffic = providerTraffic ?? DUMMY_PROVIDER_TRAFFIC;
  }

  #modelNameFallback(): string {
    return this.modelId;
  }

  #logTrafficStarted(requestId: string, requestData: Record<string, unknown>, headers?: HeadersInit): void {
    const providerTraffic = this.providerTraffic ?? DUMMY_PROVIDER_TRAFFIC;
    const model = typeof requestData.model === 'string' ? requestData.model : this.#modelNameFallback();
    const sanitizedHeaders = headers ? sanitizeHeaders(headers) : undefined;

    providerTraffic.recordRequestStart({
      requestId,
      provider: 'codex',
      model,
      sentBody: requestData,
      headers: sanitizedHeaders,
      modelClass: WS_RESPONSE_MODEL_CLASS,
      modelWrapperClass: WS_RESPONSE_WRAPPER_CLASS,
    });
  }

  #logTrafficReceived(requestId: string, requestData: Record<string, unknown>, response: unknown): void {
    const providerTraffic = this.providerTraffic ?? DUMMY_PROVIDER_TRAFFIC;
    const model = typeof requestData.model === 'string' ? requestData.model : this.#modelNameFallback();

    providerTraffic.recordResponseReceived({
      requestId,
      provider: 'codex',
      model,
      status: 200,
      response: response as any,
      transport: 'websocket',
      modelClass: WS_RESPONSE_MODEL_CLASS,
      modelWrapperClass: WS_RESPONSE_WRAPPER_CLASS,
    });
  }

  #logTrafficFailed(requestId: string, requestData: Record<string, unknown>, error: unknown): void {
    const providerTraffic = this.providerTraffic ?? DUMMY_PROVIDER_TRAFFIC;
    const model = typeof requestData.model === 'string' ? requestData.model : this.#modelNameFallback();

    providerTraffic.recordRequestFailed({
      requestId,
      provider: 'codex',
      model,
      error,
      modelClass: WS_RESPONSE_MODEL_CLASS,
      modelWrapperClass: WS_RESPONSE_WRAPPER_CLASS,
    });
  }

  async #withTrafficLogging(
    responseStream: AsyncIterable<any>,
    requestId: string,
    requestData: Record<string, unknown>,
    wireStateKey?: ChainedWireStateKey,
    wireStateToken?: ChainedRequestToken,
  ): Promise<AsyncIterable<any>> {
    const logReceived = this.#logTrafficReceived.bind(this);
    const logFailed = this.#logTrafficFailed.bind(this);
    const wireState = this.chainedWireState;

    async function* wrapped(): AsyncIterable<any> {
      try {
        for await (const event of responseStream) {
          if (
            event &&
            typeof event === 'object' &&
            ((event as any).type === 'response.completed' || (event as any).type === 'response.incomplete') &&
            (event as any).response
          ) {
            const response = (event as any).response;
            if (wireStateKey && wireStateToken && typeof response.id === 'string' && response.id.length > 0) {
              wireState.recordResponse(wireStateKey, wireStateToken, response.id, response.output);
            }
            logReceived(requestId, requestData, response);
          }
          yield event;
        }
      } catch (error) {
        if (wireStateKey) {
          wireState.invalidate(wireStateKey);
        }
        logFailed(requestId, requestData, error);
        throw error;
      } finally {
        if (wireStateKey && wireStateToken) {
          wireState.abandon(wireStateKey, wireStateToken);
        }
      }
    }

    return wrapped();
  }

  async #warmupCodexUnary(request: any | undefined): Promise<string | undefined> {
    if (!request) {
      return undefined;
    }
    const response = await super.getResponse(request);
    const responseId = getResponseIdFromResponse(response);
    this.#rememberCodexResponseId(responseId);
    return responseId;
  }

  async #warmupCodexStream(request: any | undefined): Promise<string | undefined> {
    if (!request) {
      return undefined;
    }
    let responseId: string | undefined;
    for await (const event of super.getStreamedResponse(request)) {
      responseId = getResponseIdFromStreamEvent(event) ?? responseId;
    }
    this.#rememberCodexResponseId(responseId);
    return responseId;
  }

  #prepareCodexServerHistoryRequest(request: any): any {
    const explicitPreviousResponseId =
      typeof request.previousResponseId === 'string' && request.previousResponseId.length > 0
        ? request.previousResponseId
        : undefined;
    const input = request.input;
    const previousResponseId = explicitPreviousResponseId ?? this.#getRememberedCodexResponseIdForRequest(request);

    if (!previousResponseId) {
      return request;
    }

    const consumedToolResultCallIds = this.#getConsumedToolResultCallIds(previousResponseId);
    const filteredInput = filterServerManagedInput(input, consumedToolResultCallIds);
    this.#warnIfConsumedToolResultsWereDropped(previousResponseId, input, filteredInput, consumedToolResultCallIds);
    if (request.previousResponseId === previousResponseId && filteredInput === input) {
      return request;
    }

    return {
      ...request,
      previousResponseId,
      input: filteredInput,
    };
  }

  #getRememberedCodexResponseIdForRequest(request: any): string | undefined {
    if (this.#serverHistoryReuseDisabled) {
      return undefined;
    }
    const key = this.#getCodexServerHistoryKey();
    if (!key || hasGenerateFalse(request)) {
      return undefined;
    }

    const input = request.input;
    const isInternalToolContinuation =
      Array.isArray(input) &&
      input.length > 1 &&
      input.some(isUserInputMessage) &&
      isToolResultItem(input[input.length - 1]);
    return isInternalToolContinuation ? this.codexPreviousResponseIds.get(key) : undefined;
  }

  #prepareCodexServerHistoryRequests(request: any): PreparedCodexRequest {
    const key = this.#getCodexServerHistoryKey();
    if (!key || hasGenerateFalse(request)) {
      return { request };
    }

    const preparedRequest = this.#prepareCodexServerHistoryRequest(request);
    if (preparedRequest.previousResponseId) {
      return { request: preparedRequest };
    }

    const input = request.input;
    if (!Array.isArray(input) || input.length === 0) {
      return { request };
    }

    const deltaStart = findServerManagedDeltaStart(input);
    const warmupItems: unknown[] = deltaStart > 0 ? [...input.slice(0, deltaStart)] : [];
    const rawDelta = deltaStart > 0 ? input.slice(deltaStart) : [...input];

    // The trailing walk collects interleaved function-call items alongside
    // their tool results to keep parallel outputs together.  Move those
    // function-call items back to the warmup so the server receives them
    // as history (generate: false) and can pair them with the tool results
    // that arrive in the delta request.
    const deltaInput: unknown[] = [];
    for (const item of rawDelta) {
      if (isToolResultItem(item)) {
        deltaInput.push(item);
      } else if (isToolContinuationItem(item)) {
        warmupItems.push(item);
      } else {
        deltaInput.push(item);
      }
    }

    return {
      warmupRequest: withProviderData(
        {
          ...request,
          input: warmupItems,
        },
        { generate: false },
      ),
      request: {
        ...request,
        input: deltaInput,
      },
    };
  }

  #withCodexPreviousResponseId(request: any, previousResponseId: string | undefined): any {
    if (!previousResponseId) {
      return request;
    }

    return this.#prepareCodexServerHistoryRequest({
      ...request,
      previousResponseId,
    });
  }

  #rememberCodexResponseId(responseId: string | undefined): void {
    if (!responseId) {
      return;
    }

    this.#serverHistoryReuseDisabled = false;
    const key = this.#getCodexServerHistoryKey();
    if (key) {
      this.codexPreviousResponseIds.set(key, responseId);
    }
  }

  #getConsumedToolResultCallIds(responseId: string | undefined): ReadonlySet<string> | undefined {
    if (!responseId) {
      return undefined;
    }
    return this.codexConsumedToolResultCallIdsByResponseId.get(responseId);
  }

  #warnIfConsumedToolResultsWereDropped(
    previousResponseId: string,
    input: unknown,
    filteredInput: unknown,
    consumedToolResultCallIds: ReadonlySet<string> | undefined,
  ): void {
    if (!consumedToolResultCallIds || consumedToolResultCallIds.size === 0 || filteredInput === input) {
      return;
    }

    const filteredCallIds = new Set(collectToolResultCallIds(filteredInput));
    const droppedCallIds = collectToolResultCallIds(input).filter(
      (callId) => consumedToolResultCallIds.has(callId) && !filteredCallIds.has(callId),
    );
    if (droppedCallIds.length === 0) {
      return;
    }

    this.diagnosticLogger?.debug?.('Codex provider dropped already-consumed tool outputs before continuation', {
      eventType: 'codex.tool_outputs.dropped_consumed',
      category: 'provider',
      phase: 'request_prepare',
      previousResponseId,
      droppedCallIds,
    });
  }

  #rememberConsumedToolResultCallIds(
    responseId: string | undefined,
    previousResponseId: string | undefined,
    input: unknown,
  ): void {
    if (!responseId) {
      return;
    }

    const consumed = new Set(this.#getConsumedToolResultCallIds(previousResponseId));
    for (const callId of collectToolResultCallIds(input)) {
      consumed.add(callId);
    }
    this.codexConsumedToolResultCallIdsByResponseId.set(responseId, consumed);
  }

  #forgetCodexResponseId(): void {
    this.#serverHistoryReuseDisabled = true;
    this.codexPreviousResponseIds.clear();
    this.codexConsumedToolResultCallIdsByResponseId.clear();
    this.codexTurnIdsBySession.clear();
    this.chainedWireState.clear();
  }

  #shouldForgetCodexServerHistory(error: unknown): boolean {
    const message = getErrorMessage(error);
    return (
      isPreviousResponseNotFoundError(error) ||
      message.includes('previous_response_not_found') ||
      isRetryableTransportError(error).transportFallback
    );
  }

  #getCodexServerHistoryKey(): string | null {
    const trafficContext = this.sessionContextService?.getContext() ?? null;
    return trafficContext?.providerHistoryKey ?? trafficContext?.sessionId ?? trafficContext?.traceId ?? null;
  }

  #buildCodexWebSocketIdentity(requestId: string, request: any): CodexWebSocketIdentity | undefined {
    const installationId = this.tokenManager.getInstallationId?.();
    if (typeof installationId !== 'string' || installationId.length === 0) {
      return undefined;
    }

    const sessionContext = this.sessionContextService?.getContext();
    const sessionId = sessionContext?.sessionId ?? requestId;
    const threadId = sessionId;
    const hasPreviousResponseId =
      typeof request?.previousResponseId === 'string' && request.previousResponseId.length > 0;
    const turnId = hasPreviousResponseId ? this.codexTurnIdsBySession.get(sessionId) ?? randomUUID() : randomUUID();
    this.codexTurnIdsBySession.set(sessionId, turnId);
    const windowId = `${threadId}:1`;
    const turnMetadata = JSON.stringify({
      installation_id: installationId,
      session_id: sessionId,
      thread_id: threadId,
      turn_id: turnId,
      window_id: windowId,
      request_kind: 'turn',
    });

    return {
      sessionId,
      threadId,
      turnId,
      windowId,
      turnMetadata,
      clientMetadata: {
        'x-codex-installation-id': installationId,
        session_id: sessionId,
        thread_id: threadId,
        'x-codex-window-id': windowId,
        turn_id: turnId,
        'x-codex-turn-metadata': turnMetadata,
      },
      headers: {
        'x-client-request-id': threadId,
        'session-id': sessionId,
        'thread-id': threadId,
        'x-codex-window-id': windowId,
        'x-codex-turn-metadata': turnMetadata,
      },
    };
  }

  #getEffectiveCodexRequestAfterWarmup(
    originalRequest: any,
    preparedRequest: PreparedCodexRequest,
    warmupResponseId: string | undefined,
  ): any {
    if (!preparedRequest.warmupRequest) {
      return preparedRequest.request;
    }

    return warmupResponseId
      ? this.#withCodexPreviousResponseId(preparedRequest.request, warmupResponseId)
      : originalRequest;
  }

  #withoutCodexServerHistory(request: any): any {
    if (!request || typeof request !== 'object') {
      return request;
    }

    const { previousResponseId: _previousResponseId, ...rest } = request;
    return rest;
  }

  override async getResponse(request: any): Promise<any> {
    const run = async () => {
      try {
        const preparedRequest = this.#prepareCodexServerHistoryRequests(request);
        const warmupResponseId = await this.#warmupCodexUnary(preparedRequest.warmupRequest);
        const effectiveRequest = this.#getEffectiveCodexRequestAfterWarmup(request, preparedRequest, warmupResponseId);

        const response = await super.getResponse(effectiveRequest);
        const responseId = getResponseIdFromResponse(response);
        this.#rememberCodexResponseId(responseId);
        this.#rememberConsumedToolResultCallIds(
          responseId,
          effectiveRequest.previousResponseId,
          effectiveRequest.input,
        );
        return response;
      } catch (error) {
        if (this.#shouldForgetCodexServerHistory(error)) {
          this.#forgetCodexResponseId();
          if (isPreviousResponseUnavailableError(error) && hasToolResultInput(request)) {
            throw error;
          }
          const fallbackRequest = this.#withoutCodexServerHistory(request);
          const response = await super.getResponse(fallbackRequest);
          const responseId = getResponseIdFromResponse(response);
          this.#rememberCodexResponseId(responseId);
          this.#rememberConsumedToolResultCallIds(responseId, undefined, fallbackRequest.input);
          return response;
        }
        throw error;
      }
    };

    const currentTrace = getCurrentTrace();
    if (currentTrace) {
      return run();
    }
    return withTrace('codex-responses-ws-model-trace', run);
  }

  override async *getStreamedResponse(request: any): AsyncIterable<any> {
    let yieldedAnyEvent = false;
    try {
      const preparedRequest = this.#prepareCodexServerHistoryRequests(request);
      const warmupResponseId = await this.#warmupCodexStream(preparedRequest.warmupRequest);
      const effectiveRequest = this.#getEffectiveCodexRequestAfterWarmup(request, preparedRequest, warmupResponseId);

      let responseId: string | undefined;
      for await (const event of super.getStreamedResponse(effectiveRequest)) {
        responseId = getResponseIdFromStreamEvent(event) ?? responseId;
        this.#rememberCodexResponseId(responseId);
        yieldedAnyEvent = true;
        yield event;
      }
      this.#rememberConsumedToolResultCallIds(responseId, effectiveRequest.previousResponseId, effectiveRequest.input);
    } catch (error) {
      if (this.#shouldForgetCodexServerHistory(error) && !yieldedAnyEvent) {
        this.#forgetCodexResponseId();
        if (isPreviousResponseUnavailableError(error) && hasToolResultInput(request)) {
          throw error;
        }
        const fallbackRequest = this.#withoutCodexServerHistory(request);
        let responseId: string | undefined;
        for await (const event of super.getStreamedResponse(fallbackRequest)) {
          responseId = getResponseIdFromStreamEvent(event) ?? responseId;
          this.#rememberCodexResponseId(responseId);
          yield event;
        }
        this.#rememberConsumedToolResultCallIds(responseId, undefined, fallbackRequest.input);
        return;
      }
      if (this.#shouldForgetCodexServerHistory(error)) {
        this.#forgetCodexResponseId();
      }
      throw error;
    }
  }

  override _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = super._buildResponsesCreateRequest(request, stream);
    const requestData = normalizeCodexRequestData(built.requestData, request, this.modelId, {
      includeDeveloperInstructionsOnChainedRequest: true,
    });
    const wireStateKey = RESPONSES_LITE_MODELS.has(this.modelId) ? this.#getCodexServerHistoryKey() : null;

    if (!wireStateKey) {
      return { ...built, requestData };
    }

    const token = this.requestTokens.get(request) ?? randomUUID();
    this.requestTokens.set(request, token);
    const prepared = this.chainedWireState.prepare(wireStateKey, token, requestData);

    return {
      ...built,
      requestData: prepared.requestData,
    };
  }

  protected override async _fetchResponse(request: any, stream: boolean): Promise<any> {
    const requestId = randomUUID();
    const wireStateKey = RESPONSES_LITE_MODELS.has(this.modelId)
      ? this.#getCodexServerHistoryKey() ?? undefined
      : undefined;

    const accessToken = await this.tokenManager.getOrRefreshAccessToken();
    const accountId = this.tokenManager.getAccountId();

    const codexIdentity = this.#buildCodexWebSocketIdentity(requestId, request);
    const extraHeaders: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
      originator: 'codex_exec',
    };
    if (codexIdentity) {
      Object.assign(extraHeaders, codexIdentity.headers);
    }
    const isResponsesLite = RESPONSES_LITE_MODELS.has(this.modelId);
    if (isResponsesLite) {
      extraHeaders['x-openai-internal-codex-responses-lite'] = 'true';
    }
    if (accountId) {
      extraHeaders['chatgpt-account-id'] = accountId;
    }

    const updatedRequest = {
      ...request,
      signal: undefined as AbortSignal | undefined,
      modelSettings: {
        ...request.modelSettings,
        providerData: {
          ...request.modelSettings?.providerData,
          ...(codexIdentity
            ? {
                client_metadata: {
                  ...request.modelSettings?.providerData?.client_metadata,
                  ...codexIdentity.clientMetadata,
                },
              }
            : {}),
          ...(isResponsesLite
            ? {
                client_metadata: {
                  ...request.modelSettings?.providerData?.client_metadata,
                  ...(codexIdentity?.clientMetadata ?? {}),
                  ws_request_header_x_openai_internal_codex_responses_lite: 'true',
                },
              }
            : {}),
          extraHeaders: {
            ...request.modelSettings?.providerData?.extraHeaders,
            ...extraHeaders,
          },
        },
      },
    };
    const watchdog = createWebSocketReceiveWatchdog(request.signal, this.websocketReceiveTimeouts);
    updatedRequest.signal = watchdog.signal;

    const builtRequest = (this as any)._buildResponsesCreateRequest(updatedRequest, true);
    const requestData = (asRecord(builtRequest?.requestData) ?? {}) as Record<string, unknown>;
    const wireStateToken = this.requestTokens.get(updatedRequest);
    this.#logTrafficStarted(requestId, requestData, extraHeaders);

    if (!stream) {
      try {
        const response = await fetchAndReconstructUnaryResponse(
          async () =>
            watchdog.wrap(
              await (super._fetchResponse(updatedRequest, true as false) as unknown as Promise<AsyncIterable<any>>),
            ),
          this.diagnosticLogger,
        );
        if (wireStateKey && wireStateToken && typeof response?.id === 'string' && response.id.length > 0) {
          this.chainedWireState.recordResponse(wireStateKey, wireStateToken, response.id, response.output);
        }
        this.#logTrafficReceived(requestId, requestData, response);
        return response;
      } catch (error) {
        const timeoutError = watchdog.timeoutError();
        watchdog.close();
        if (wireStateKey) {
          this.chainedWireState.invalidate(wireStateKey);
        }
        this.#logTrafficFailed(requestId, requestData, timeoutError ?? error);
        throw timeoutError ?? error;
      }
    }

    try {
      const response = (await super._fetchResponse(updatedRequest, stream as false)) as unknown as AsyncIterable<any>;
      const patched = wrapCodexStream(watchdog.wrap(response), this.diagnosticLogger);
      return this.#withTrafficLogging(patched, requestId, requestData, wireStateKey, wireStateToken);
    } catch (error) {
      const timeoutError = watchdog.timeoutError();
      watchdog.close();
      if (wireStateKey) {
        this.chainedWireState.invalidate(wireStateKey);
      }
      this.#logTrafficFailed(requestId, requestData, timeoutError ?? error);
      throw timeoutError ?? error;
    }
  }
}

export class CodexResponsesModel extends OpenAIResponsesModel {
  constructor(client: any, private readonly modelId: string, private readonly diagnosticLogger?: DiagnosticLogger) {
    super(client, modelId);
  }

  override _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest.call(this, request, stream);

    return {
      ...built,
      requestData: normalizeCodexRequestData(built.requestData, request, this.modelId),
    };
  }

  protected override async _fetchResponse(request: any, stream: boolean): Promise<any> {
    if (!stream) {
      return fetchAndReconstructUnaryResponse(
        () => (OpenAIResponsesModel.prototype as any)._fetchResponse.call(this, request, true),
        this.diagnosticLogger,
      );
    }

    const response = await (OpenAIResponsesModel.prototype as any)._fetchResponse.call(this, request, stream);
    return wrapCodexStream(response, this.diagnosticLogger);
  }
}

async function fetchAndReconstructUnaryResponse(
  fetchStream: () => Promise<AsyncIterable<any>>,
  logger?: DiagnosticLogger,
): Promise<any> {
  const eventStream = wrapCodexStream(await fetchStream(), logger);
  let finalResponse: any = null;
  for await (const event of eventStream) {
    if (TERMINAL_RESPONSE_EVENT_TYPES.has(event?.type) && event.response) {
      finalResponse = event.response;
    }
  }
  if (!finalResponse) {
    throw new Error('Codex connection closed before a terminal response event.');
  }
  return finalResponse;
}

export async function* wrapCodexStream(source: AsyncIterable<any>, logger?: DiagnosticLogger): AsyncIterable<any> {
  let accumulatedItems: any[] = [];
  // Track call_id values from function_call_arguments events keyed by item_id,
  // since the Codex server may omit call_id on output_item.done for function_calls
  // while still expecting it on continuation requests.
  const itemCallIds = new Map<string, string>();

  for await (let event of source) {
    const type = event?.type;
    if (type === 'response.error') {
      const errMsg = event.error?.message || JSON.stringify(event.error ?? event);
      logger?.error?.('Codex stream received response.error event', {
        eventType: 'codex.response.stream_error_event',
        error: event.error ?? event,
      });
      throw new Error(`Codex provider stream error: ${errMsg}`);
    }

    if (
      type === 'response.function_call_arguments.done' &&
      typeof event.call_id === 'string' &&
      typeof event.item_id === 'string'
    ) {
      // Capture the authoritative call_id from the arguments-done event.
      itemCallIds.set(event.item_id, event.call_id);
    }

    if (type === 'response.output_item.done' && event.item) {
      const item = event.item;
      const itemRecord = asRecord(item);
      // If the accumulated function_call item is missing call_id, backfill it
      // from the itemCallIds map so the SDK's convertToOutputItem picks up the
      // correct identifier and the continuation request sends the right call_id.
      if (
        itemRecord?.type === 'function_call' &&
        !stringValue(itemRecord?.call_id) &&
        typeof itemRecord?.id === 'string'
      ) {
        const knownCallId = itemCallIds.get(itemRecord.id);
        if (knownCallId) {
          // Clone the item with the backfilled call_id.
          event = { ...event, item: { ...itemRecord, call_id: knownCallId } };
        }
      }
      accumulatedItems.push(event.item);
    } else if (TERMINAL_RESPONSE_EVENT_TYPES.has(type) && event.response) {
      // Clear the per-turn map on terminal events so we don't leak IDs across responses.
      itemCallIds.clear();

      const output = event.response.output;
      const isMissingOrEmptyOutput = output === undefined || (Array.isArray(output) && output.length === 0);
      if (isMissingOrEmptyOutput && accumulatedItems.length > 0) {
        const reconstructedOutput = accumulatedItems;
        accumulatedItems = [];
        if (reconstructedOutput.length >= SUSPICIOUS_RECONSTRUCTED_OUTPUT_ITEM_COUNT) {
          logger?.warn?.('Codex stream reconstructed a suspiciously large completed response output', {
            eventType: 'codex.reconstructed_output.suspicious',
            category: 'provider',
            phase: 'provider_response',
            responseId: stringValue(event.response.id),
            ...summarizeReconstructedItems(reconstructedOutput),
          });
        }
        try {
          event.response.output = reconstructedOutput;
        } catch {
          // Response object may be frozen; clone with the reconstructed output.
          event = { ...event, response: { ...event.response, output: reconstructedOutput } };
        }
      } else {
        accumulatedItems = [];
      }

      // Check if output is still missing/empty and there's a failed status or error details
      const finalOutput = event.response.output;
      const isStillMissingOutput =
        finalOutput === undefined || (Array.isArray(finalOutput) && finalOutput.length === 0);
      if (isStillMissingOutput) {
        if (event.response.error) {
          const errMsg = event.response.error.message || JSON.stringify(event.response.error);
          logger?.error?.(`Codex response terminal event "${type}" has error details`, {
            eventType: 'codex.response.terminal_error',
            responseId: event.response.id,
            status: event.response.status,
            error: event.response.error,
          });
          throw new Error(`Codex provider error: ${errMsg}`);
        } else if (event.response.status === 'failed') {
          logger?.error?.(`Codex response terminal event "${type}" has failed status without error details`, {
            eventType: 'codex.response.terminal_failed',
            responseId: event.response.id,
            status: event.response.status,
          });
          throw new Error(`Codex provider response failed without explicit error details.`);
        }
      }
    }
    yield event;
  }
}
