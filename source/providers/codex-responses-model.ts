import { randomUUID } from 'node:crypto';
import { ResponsesWS } from 'openai/resources/responses/ws';
import OpenAI from 'openai';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';
import { toCodexResponsesInput } from './codex-turn-converter.js';
import { sanitizeHeaders } from '../utils/header-sanitizer.js';
import type { ISessionContextService, IProviderTraffic } from '../services/service-interfaces.js';
import { OrphanedChainedToolOutputError } from '../lib/chained-input-filter.js';
import { AmbiguousModelOutcomeError } from '../services/retry/retry-errors.js';
import { ChainedWireState, type ChainedWireStateKey, type ChainedRequestToken } from './chained-wire-state.js';
import { LunaResponsesLiteWireProtocol } from './luna-responses-lite-wire-protocol.js';
import { captureProviderRequest, type ProviderRequestCapture } from './provider-request-capture.js';
import {
  createWebSocketReceiveWatchdog,
  DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS,
  type WebSocketReceiveTimeouts,
} from './websocket-receive-watchdog.js';

const DUMMY_PROVIDER_TRAFFIC: IProviderTraffic = {
  recordRequestStart() {},
  async recordResponseReceived() {},
  recordResponseClosed() {},
  recordRequestFailed() {},
};

function toCodexToolChoice(choice: unknown): unknown {
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  if (choice && typeof choice === 'object' && typeof (choice as { name?: unknown }).name === 'string') {
    return { type: 'function', name: (choice as { name: string }).name };
  }
  throw new Error('Unsupported Codex tool choice.');
}

/** Provider-owned transport seam used by Codex's HTTP and WebSocket models. */
export class CodexResponsesTransport {
  constructor(private readonly client: any = {}, private readonly model = '', private readonly websocket = false) {}

  buildResponsesCreateRequest(request: StreamedModelTurnRequest, stream: boolean): any {
    const providerOptions = request.providerOptions ?? {};
    const { extraBody, extraHeaders: _extraHeaders, ...nativeProviderData } = providerOptions;
    return {
      requestData: {
        model: this.model,
        input: toCodexResponsesInput(request.input),
        stream,
        ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
        ...(request.tools.length > 0 ? { tools: request.tools.map((tool) => ({ type: 'function', ...tool })) } : {}),
        ...(request.toolChoice !== undefined ? { tool_choice: toCodexToolChoice(request.toolChoice) } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
        ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
        ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
        ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
        ...nativeProviderData,
        ...(extraBody ?? {}),
        ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
        ...(request.codex?.promptCacheKey ? { prompt_cache_key: request.codex.promptCacheKey } : {}),
        ...(request.codex?.include ? { include: request.codex.include } : {}),
      },
    };
  }

  async fetchResponse(request: StreamedModelTurnRequest, stream: boolean, requestData: any): Promise<any> {
    if (stream && this.websocket) {
      if (!(this.client instanceof OpenAI) && typeof this.client?.responses?.create === 'function') {
        return this.client.responses.create(requestData);
      }
      const headers = request.providerOptions?.extraHeaders;
      const socket = new ResponsesWS(this.client, headers ? { headers: headers as Record<string, string> } : undefined);
      const messages = socket.stream();
      const requestEvent = { type: 'response.create', ...requestData } as any;
      if ((socket as any).socket?.readyState === 0) {
        (socket as any).socket.once('open', () => socket.send(requestEvent));
      } else {
        socket.send(requestEvent);
      }
      return (async function* () {
        try {
          for await (const message of messages) {
            if (message.type === 'message') yield message.message;
            else if ((message as any).event) yield (message as any).event;
            else if (message.type === 'error') throw (message as any).error;
            else if (message.type === 'close')
              throw new Error('Codex WebSocket connection closed before a terminal response event.');
          }
        } finally {
          try {
            socket.close();
          } catch {
            /* best effort */
          }
        }
      })();
    }
    return this.client.responses.create(requestData, {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.providerOptions?.extraHeaders ? { headers: request.providerOptions.extraHeaders } : {}),
    });
  }
}

export class OpenAIResponsesModel implements StreamedModelTurn {
  protected readonly client: any;
  protected readonly model: string;
  public readonly transport: CodexResponsesTransport;
  constructor(client: any, model: string, transport?: CodexResponsesTransport, websocket = false) {
    this.client = client;
    this.model = model;
    this.transport = transport ?? new CodexResponsesTransport(client, model, websocket);
  }

  protected buildResponsesCreateRequest(request: StreamedModelTurnRequest, stream: boolean): any {
    const built = this.transport.buildResponsesCreateRequest(request, stream);
    if (this.transport instanceof CodexResponsesTransport && built?.requestData) {
      built.requestData.model = this.model;
    }
    return built;
  }

  protected async fetchResponse(request: StreamedModelTurnRequest, stream: boolean): Promise<any> {
    const built = this.buildResponsesCreateRequest(request, stream);
    return this.transport.fetchResponse(request, stream, built.requestData);
  }

  protected async fetchUnaryResponse(request: StreamedModelTurnRequest): Promise<any> {
    return this.fetchResponse(request, false);
  }

  protected async *rawStream(request: StreamedModelTurnRequest): AsyncIterable<any> {
    const source = await this.fetchResponse(request, true);
    for await (const event of source) {
      if (event?.type === 'error') throw new Error(event.error?.message ?? 'Codex WebSocket provider error');
      if (event?.type === 'close')
        throw new Error('Codex WebSocket connection closed before a terminal response event.');
      yield event;
      if (
        event?.type === 'response.completed' ||
        event?.type === 'response.incomplete' ||
        event?.type === 'response.failed'
      )
        return;
    }
  }

  async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
    yield* convertCodexRawStream(this.rawStream(request));
  }
}

export class OpenAIResponsesWSModel extends OpenAIResponsesModel {
  constructor(client: any, model: string, transport?: CodexResponsesTransport) {
    super(client, model, transport, true);
  }
}
async function* convertCodexRawStream(source: AsyncIterable<any>): AsyncIterable<StreamedModelTurnEvent> {
  const output: any[] = [];
  const pendingToolCalls: Extract<StreamedModelTurnEvent, { type: 'tool_call' }>[] = [];
  const terminalReasoning: any[] = [];
  const toolNamesByIndex = new Map<number | string, string>();
  const toolArgumentLengthsByIndex = new Map<number | string, number>();
  let sawReasoningDelta = false;
  let responseId = '';
  let finishReason: string | undefined;
  let usage: Extract<StreamedModelTurnEvent, { type: 'completion' }>['usage'];
  let sawCompletedResponse = false;
  for await (const event of source) {
    if (event?.type === 'codex.rate_limits') {
      const rateLimits = event.rate_limits ?? event;
      if (rateLimits && typeof rateLimits === 'object') yield { type: 'codex_rate_limits', rateLimits };
    } else if (event?.type === 'response.output_text.delta') {
      yield { type: 'text_delta', text: String(event.delta ?? '') };
    } else if (event?.type === 'response.reasoning_summary_text.delta') {
      const text = String(event.delta ?? '');
      if (text) {
        sawReasoningDelta = true;
        yield {
          type: 'reasoning_delta',
          ...(typeof event.item_id === 'string' ? { id: event.item_id } : {}),
          text,
        };
      }
    } else if (event?.type === 'response.output_item.added' && event.output_item?.type === 'function_call') {
      const index = typeof event.output_index === 'number' ? event.output_index : event.output_item.id ?? 0;
      if (typeof event.output_item.name === 'string') toolNamesByIndex.set(index, event.output_item.name);
      toolArgumentLengthsByIndex.set(index, 0);
    } else if (
      (event?.type === 'response.function_call_arguments.delta' ||
        event?.type === 'response.custom_tool_call_input.delta' ||
        event?.type === 'response.mcp_call_arguments.delta') &&
      typeof event.delta === 'string' &&
      event.delta
    ) {
      const index = typeof event.output_index === 'number' ? event.output_index : event.item_id ?? 0;
      const argumentCharCount = (toolArgumentLengthsByIndex.get(index) ?? 0) + event.delta.length;
      toolArgumentLengthsByIndex.set(index, argumentCharCount);
      const toolName = toolNamesByIndex.get(index);
      yield { type: 'tool_call_streaming_delta', ...(toolName ? { toolName } : {}), argumentCharCount };
    } else if (event?.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const call = toCodexToolCallOutput(event.item);
      output.push(call);
      pendingToolCalls.push(call);
    } else if (event?.type === 'response.completed') {
      sawCompletedResponse = true;
      responseId = codexString(event.response?.id) ?? responseId;
      finishReason = codexString(event.response?.status) ?? codexString(event.response?.incomplete_details?.reason);
      usage = toCodexUsage(event.response?.usage);
      for (const item of event.response?.output ?? []) {
        const converted = toCodexOutputItem(item);
        if (converted.type !== 'tool_call') {
          output.push(converted);
          if (converted.type === 'reasoning') terminalReasoning.push(converted);
        }
      }
      const authoritativeReasoning = sawReasoningDelta ? [] : terminalReasoning;
      for (const reasoning of authoritativeReasoning) {
        yield {
          type: 'reasoning_delta',
          ...(reasoning.id ? { id: reasoning.id } : {}),
          text: reasoning.text,
          ...(reasoning.providerMetadata ? { providerMetadata: reasoning.providerMetadata } : {}),
        };
      }
      for (const call of pendingToolCalls) yield call;
      break;
    } else if (
      event?.type === 'response.incomplete' ||
      event?.type === 'response.failed' ||
      event?.type === 'response.error'
    ) {
      const status = String(event.type).slice('response.'.length);
      const message = event.response?.error?.message ?? event.error?.message ?? `Codex response ${status}`;
      throw new Error(`Codex provider response ${status}: ${message}`);
    }
  }
  if (!sawCompletedResponse) throw new Error('Codex streamed response ended without a completed response event.');
  if (!responseId) throw new Error('Codex completed response did not include an id.');
  yield {
    type: 'completion',
    responseId,
    output,
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  };
}

function toCodexToolCallOutput(item: any): Extract<StreamedModelTurnEvent, { type: 'tool_call' }> {
  const id = codexString(item?.call_id) ?? codexString(item?.id);
  const name = codexString(item?.name);
  if (!id || !name) throw new Error('Codex function call output is missing its call id or name.');
  return { type: 'tool_call', id, name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' };
}

function toCodexOutputItem(item: any): any {
  if (!item || typeof item !== 'object') throw new Error('Unsupported Codex response output item.');
  if (item.type === 'function_call') return toCodexToolCallOutput(item);
  if (item.type === 'message') {
    const content = Array.isArray(item.content) ? item.content : [];
    return {
      type: 'message',
      content: content.map((part: any) => {
        if (part?.type && !['output_text', 'input_text', 'text'].includes(part.type))
          throw new Error(`Unsupported Codex response message content: ${String(part.type)}.`);
        if (typeof part?.text !== 'string') throw new Error('Unsupported Codex response message content without text.');
        return { type: 'text', text: part.text };
      }),
    };
  }
  if (item.type === 'reasoning') {
    return {
      type: 'reasoning',
      ...(codexString(item.id) ? { id: item.id } : {}),
      text: codexReasoningText(item.summary ?? item.content ?? ''),
      providerMetadata: { codex: codexReasoningMetadata(item) },
    };
  }
  throw new Error(`Unsupported Codex response output item type: ${String(item.type)}.`);
}

function codexReasoningText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part: any) => {
      if (!part || typeof part !== 'object' || typeof part.text !== 'string')
        throw new Error('Unsupported Codex reasoning content without text.');
      return part.text;
    })
    .join('');
}

function codexReasoningMetadata(item: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, id: _id, summary: _summary, content: _content, ...metadata } = item;
  return metadata;
}

function toCodexUsage(rawUsage: any): Extract<StreamedModelTurnEvent, { type: 'completion' }>['usage'] {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined;
  const inputTokens = rawUsage.input_tokens ?? rawUsage.inputTokens;
  const outputTokens = rawUsage.output_tokens ?? rawUsage.outputTokens;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const cachedInputTokens = rawUsage.input_tokens_details?.cached_tokens ?? rawUsage.inputTokensDetails?.cachedTokens;
  const cacheWriteTokens =
    rawUsage.input_tokens_details?.cache_write_tokens ?? rawUsage.inputTokensDetails?.cacheWriteTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

function codexString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

import {
  isPreviousResponseNotFoundError,
  isRetryableTransportError,
  isWebSocketConnectionLimitReachedError,
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

  // Codex responses endpoint rejects temperature and max_output_tokens; always omit them.
  if ('temperature' in normalizedRequestData) {
    delete normalizedRequestData.temperature;
  }
  if ('max_output_tokens' in normalizedRequestData) {
    delete normalizedRequestData.max_output_tokens;
  }

  const hasPreviousResponseId =
    (typeof normalizedRequestData.previous_response_id === 'string' &&
      normalizedRequestData.previous_response_id.length > 0) ||
    (typeof request?.previousResponseId === 'string' && request.previousResponseId.length > 0);
  const normalizedInput =
    !hasPreviousResponseId && Array.isArray(normalizedRequestData.input)
      ? dropUnpairedCodexToolItems(normalizedRequestData.input)
      : normalizedRequestData.input;
  normalizedRequestData.input = stripCodexReplayIds(
    Array.isArray(normalizedInput)
      ? normalizedInput.map((item: any) => {
          if (item?.type === 'function_call_result' || item?.type === 'function_call_output') {
            // The Responses API rejects unknown parameters, so the camelCase
            // spellings must be dropped, not just shadowed by the snake_case one
            // added below — spreading `...item` alone leaves `callId` on the
            // object alongside the new `call_id`.
            const { callId: _callId, call_id: _call_id, tool_call_id: _toolCallId, ...rest } = item;
            return {
              ...rest,
              type: 'function_call_output',
              call_id: item.call_id ?? item.callId ?? item.tool_call_id,
              // Responses supports rich function output content (input text,
              // images, and files). Preserve the already-normalized array;
              // only legacy object output needs JSON serialization.
              output:
                typeof item.output === 'string' || Array.isArray(item.output)
                  ? item.output
                  : JSON.stringify(item.output ?? ''),
            };
          }
          if (item?.type === 'function_call' && item.callId && !item.call_id) {
            const { callId: _callId, ...rest } = item;
            return { ...rest, call_id: item.callId };
          }
          return item;
        })
      : normalizedInput,
  );

  const modelInclude = request?.codex?.include;
  if (Array.isArray(modelInclude) && modelInclude.length > 0) {
    const existingInclude = Array.isArray(normalizedRequestData.include) ? normalizedRequestData.include : [];
    normalizedRequestData.include = Array.from(
      new Set([...existingInclude, ...modelInclude].filter((entry) => typeof entry === 'string' && entry.length > 0)),
    );
  }

  const promptCacheKey = request?.codex?.promptCacheKey;
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
// `response.output_item.done`. The application transport must treat the
// terminal frame as authoritative; when it is empty or missing, retaining the
// completed output items prevents a false empty completion.
//
// The Codex transport accumulates raw items from `response.output_item.done`
// and, only when terminal `response.output` is empty or missing, uses those
// accumulated items for its application-owned completion event.
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
  const callId =
    stringValue(record?.call_id) ??
    stringValue(record?.callId) ??
    stringValue(record?.tool_call_id) ??
    (type === 'tool_call' || type === 'tool_result' ? stringValue(record?.id) : undefined);

  return {
    type,
    itemId,
    callId,
    isFunctionCall: type === 'function_call' || type === 'tool_call',
    isToolResult:
      type === 'tool_result' || (typeof type === 'string' && CODEX_SERVER_HISTORY_TOOL_RESULT_TYPES.has(type)),
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
  let endUserIndex = input.length;
  while (endUserIndex > 0 && isUserInputMessage(input[endUserIndex - 1])) {
    endUserIndex--;
  }

  if (endUserIndex > 0 && isToolContinuationItem(input[endUserIndex - 1])) {
    let toolStart = endUserIndex;
    while (toolStart > 0 && isToolContinuationItem(input[toolStart - 1])) {
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

const collectFunctionCallIds = (input: unknown): string[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  const ids: string[] = [];
  for (const item of input) {
    const normalized = normalizeCodexServerHistoryItem(item);
    if (normalized.isFunctionCall && normalized.callId) {
      ids.push(normalized.callId);
    }
  }
  return ids;
};

const dropUnpairedCodexToolItems = (history: readonly unknown[]): unknown[] => {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const item of history) {
    const normalized = normalizeCodexServerHistoryItem(item);
    if (!normalized.callId) continue;
    if (normalized.isFunctionCall) callIds.add(normalized.callId);
    if (normalized.isToolResult) resultIds.add(normalized.callId);
  }
  if (callIds.size === 0 && resultIds.size === 0) return history as unknown[];
  const filtered = history.filter((item) => {
    const normalized = normalizeCodexServerHistoryItem(item);
    if (!normalized.callId) return true;
    if (normalized.isFunctionCall) return resultIds.has(normalized.callId);
    if (normalized.isToolResult) return callIds.has(normalized.callId);
    return true;
  });
  return filtered.length === history.length ? (history as unknown[]) : filtered;
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
  // previous response's function call(s) — or tool-call output(s) followed by
  // user steer message(s) admitted mid-turn.
  let endUserIndex = input.length;
  while (endUserIndex > 0 && isUserInputMessage(input[endUserIndex - 1])) {
    endUserIndex--;
  }

  if (endUserIndex > 0 && isToolResultItem(input[endUserIndex - 1])) {
    let start = endUserIndex - 1;
    while (start > 0 && isToolContinuationItem(input[start - 1])) {
      start--;
    }
    const trailing = input.slice(start, endUserIndex);
    // A clean run of tool results (grouped layout) needs no filtering; for
    // the paired layout, drop the interleaved function-call items.
    const toolResults = trailing.every(isToolResultItem) ? trailing : trailing.filter(isToolResultItem);
    const filteredToolResults = filterConsumedToolResults(toolResults, consumedToolResultCallIds);
    const trailingUserMessages = input.slice(endUserIndex);
    return [...(filteredToolResults as unknown[]), ...trailingUserMessages];
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
  const candidate = asRecord(event);
  if (
    !candidate ||
    !['response.completed', 'response.incomplete', 'response.failed'].includes(String(candidate.type))
  ) {
    return undefined;
  }
  return getResponseIdFromResponse(candidate.response) ?? getResponseIdFromResponse(candidate);
};

const getResponseOutputFromStreamEvent = (event: unknown): unknown[] | undefined => {
  const candidate = asRecord(event);
  if (
    !candidate ||
    !['response.completed', 'response.incomplete', 'response.failed'].includes(String(candidate.type))
  ) {
    return undefined;
  }
  const response = asRecord(candidate.response);
  return Array.isArray(response?.output) ? response.output : undefined;
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

const isDefinitelyUnsentWebSocketError = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (!error || seen.has(error)) return false;
  seen.add(error);

  // The server explicitly rejects this request before model generation and
  // instructs the client to reconnect. Retrying from durable history is safe;
  // treating it as an ambiguous model outcome would suppress recovery.
  if (isWebSocketConnectionLimitReachedError(error)) return true;

  if (typeof error === 'string') {
    const message = error.toLowerCase();
    return (
      message.includes('before opening') ||
      message.includes('timed out before opening') ||
      message.includes('econnrefused') ||
      message.includes('enotfound')
    );
  }
  if (typeof error !== 'object') return false;

  const record = error as Record<string, unknown>;
  if (
    record.code === 'connection_closed_before_opening' ||
    record.code === 'ECONNREFUSED' ||
    record.code === 'ENOTFOUND'
  ) {
    return true;
  }
  return isDefinitelyUnsentWebSocketError(record.message, seen) || isDefinitelyUnsentWebSocketError(record.cause, seen);
};

const asAmbiguousModelOutcome = (error: unknown): AmbiguousModelOutcomeError | undefined => {
  if (!isRetryableTransportError(error).transportFallback || isDefinitelyUnsentWebSocketError(error)) {
    return undefined;
  }
  return new AmbiguousModelOutcomeError(getErrorMessage(error) || 'Codex request outcome is unknown.', {
    cause: error,
  });
};

const hasGenerateFalse = (request: StreamedModelTurnRequest): boolean => request.providerOptions?.generate === false;

const withProviderOptions = (
  request: StreamedModelTurnRequest,
  providerOptions: Record<string, unknown>,
): StreamedModelTurnRequest => ({
  ...request,
  providerOptions: {
    ...request.providerOptions,
    ...providerOptions,
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
  private readonly codexFunctionCallIdsByResponseId = new Map<string, Set<string>>();
  private readonly codexTurnIdsBySession = new Map<string, string>();
  #serverHistoryReuseDisabled = false;

  private readonly providerTraffic: IProviderTraffic;
  private readonly diagnosticLogger?: DiagnosticLogger;
  private readonly sessionContextService?: ISessionContextService;
  private readonly requestCapture?: ProviderRequestCapture;
  private readonly chainedWireState = new ChainedWireState(new LunaResponsesLiteWireProtocol());
  private readonly requestTokens = new WeakMap<object, ChainedRequestToken>();
  private readonly websocketReceiveTimeouts: WebSocketReceiveTimeouts;

  constructor(
    client: any,
    private readonly modelId: string,
    private readonly tokenManager: any,
    diagnosticLogger?: DiagnosticLogger | CodexResponsesTransport,
    providerTraffic?: IProviderTraffic | CodexResponsesTransport,
    sessionContextService?: ISessionContextService | CodexResponsesTransport,
    websocketReceiveTimeouts: WebSocketReceiveTimeouts | CodexResponsesTransport = DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS,
    requestCapture?: ProviderRequestCapture | CodexResponsesTransport,
    transport?: CodexResponsesTransport,
  ) {
    const candidates = [
      transport,
      diagnosticLogger,
      providerTraffic,
      sessionContextService,
      websocketReceiveTimeouts,
      requestCapture,
    ];
    const injectedTransport = candidates.find(
      (candidate): candidate is CodexResponsesTransport => candidate instanceof CodexResponsesTransport,
    );
    super(client, modelId, injectedTransport);
    this.diagnosticLogger = diagnosticLogger instanceof CodexResponsesTransport ? undefined : diagnosticLogger;
    this.providerTraffic =
      providerTraffic instanceof CodexResponsesTransport
        ? DUMMY_PROVIDER_TRAFFIC
        : providerTraffic ?? DUMMY_PROVIDER_TRAFFIC;
    this.sessionContextService =
      sessionContextService instanceof CodexResponsesTransport ? undefined : sessionContextService;
    this.websocketReceiveTimeouts =
      websocketReceiveTimeouts instanceof CodexResponsesTransport
        ? DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS
        : websocketReceiveTimeouts;
    this.requestCapture = requestCapture instanceof CodexResponsesTransport ? undefined : requestCapture;
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

  #logTrafficClosed(
    requestId: string,
    requestData: Record<string, unknown>,
    outcome: 'consumer_closed' | 'aborted',
    eventCount: number,
  ): void {
    const providerTraffic = this.providerTraffic ?? DUMMY_PROVIDER_TRAFFIC;
    const model = typeof requestData.model === 'string' ? requestData.model : this.#modelNameFallback();

    providerTraffic.recordResponseClosed({
      requestId,
      provider: 'codex',
      model,
      outcome,
      eventCount,
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
    signal?: AbortSignal,
  ): Promise<AsyncIterable<any>> {
    const logReceived = this.#logTrafficReceived.bind(this);
    const logFailed = this.#logTrafficFailed.bind(this);
    const logClosed = this.#logTrafficClosed.bind(this);
    const wireState = this.chainedWireState;

    async function* wrapped(): AsyncIterable<any> {
      let sawTerminalEvent = false;
      let sourceExhausted = false;
      let streamFailed = false;
      let eventCount = 0;
      try {
        for await (const event of responseStream) {
          eventCount += 1;
          if (
            event &&
            typeof event === 'object' &&
            ((event as any).type === 'response.completed' ||
              (event as any).type === 'response.incomplete' ||
              (event as any).type === 'response.failed')
          ) {
            sawTerminalEvent = true;
          }
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
        sourceExhausted = true;
      } catch (error) {
        streamFailed = true;
        if (wireStateKey && !isWebSocketConnectionLimitReachedError(error)) {
          wireState.invalidate(wireStateKey);
        }
        logFailed(requestId, requestData, error);
        throw error;
      } finally {
        if (!sawTerminalEvent && !sourceExhausted && !streamFailed) {
          logClosed(requestId, requestData, signal?.aborted ? 'aborted' : 'consumer_closed', eventCount);
        }
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
    const response = await super.fetchUnaryResponse(request);
    const responseId = getResponseIdFromResponse(response);
    this.#rememberCodexResponseId(responseId, asRecord(response)?.output, request.input, true);
    return responseId;
  }

  async #warmupCodexStream(request: any | undefined): Promise<string | undefined> {
    if (!request) {
      return undefined;
    }
    let responseId: string | undefined;
    for await (const event of super.rawStream(request)) {
      const eventResponseId = getResponseIdFromStreamEvent(event);
      if (eventResponseId) {
        responseId = eventResponseId;
        this.#rememberCodexResponseId(responseId, getResponseOutputFromStreamEvent(event), request.input, true);
      }
    }
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
    const knownFunctionCallIds = this.codexFunctionCallIdsByResponseId.get(previousResponseId);
    if (request.previousResponseId === previousResponseId && knownFunctionCallIds) {
      const orphanedCallIds = collectToolResultCallIds(filteredInput).filter(
        (callId) => !knownFunctionCallIds.has(callId),
      );
      if (orphanedCallIds.length > 0) {
        throw new OrphanedChainedToolOutputError([...new Set(orphanedCallIds)]);
      }
    }
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

    const hasToolResultBeforeTrailingUserMessages = (items: readonly unknown[]): boolean => {
      let endUserIndex = items.length;
      while (endUserIndex > 0 && isUserInputMessage(items[endUserIndex - 1])) {
        endUserIndex--;
      }
      return endUserIndex > 0 && isToolResultItem(items[endUserIndex - 1]);
    };

    const input = request.input;
    const isInternalToolContinuation =
      Array.isArray(input) &&
      input.length > 1 &&
      input.some(isUserInputMessage) &&
      hasToolResultBeforeTrailingUserMessages(input);
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

    const input = Array.isArray(request.input) ? dropUnpairedCodexToolItems(request.input) : request.input;
    const replayRequest = input === request.input ? request : { ...request, input };
    if (!Array.isArray(input) || input.length === 0) {
      return { request: replayRequest };
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
      warmupRequest: withProviderOptions(
        {
          ...replayRequest,
          input: warmupItems,
        },
        { generate: false },
      ),
      request: {
        ...replayRequest,
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

  #rememberCodexResponseId(
    responseId: string | undefined,
    output?: unknown,
    input?: unknown,
    recordChainAnchor = false,
  ): void {
    if (!responseId) {
      return;
    }

    this.#serverHistoryReuseDisabled = false;
    const key = this.#getCodexServerHistoryKey();
    if (key) {
      this.codexPreviousResponseIds.set(key, responseId);
    }
    if (recordChainAnchor && (Array.isArray(output) || Array.isArray(input))) {
      this.codexFunctionCallIdsByResponseId.set(
        responseId,
        new Set([...collectFunctionCallIds(output), ...collectFunctionCallIds(input)]),
      );
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
    // A continuation may explicitly reuse the prior response ID; retain the
    // consumed-output checkpoint under that anchor as well as the new response.
    if (previousResponseId) this.codexConsumedToolResultCallIdsByResponseId.set(previousResponseId, consumed);
  }

  #forgetCodexResponseId(): void {
    this.#serverHistoryReuseDisabled = true;
    this.codexPreviousResponseIds.clear();
    this.codexConsumedToolResultCallIdsByResponseId.clear();
    this.codexFunctionCallIdsByResponseId.clear();
    this.codexTurnIdsBySession.clear();
    this.chainedWireState.clear();
  }

  #shouldForgetCodexServerHistory(error: unknown): boolean {
    // This rejects the new request before generation; it expires the socket,
    // not the last acknowledged response. Retaining that response keeps an
    // already-executed tool output paired with the call that introduced it.
    if (isWebSocketConnectionLimitReachedError(error)) {
      return false;
    }

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

  protected override async fetchUnaryResponse(request: StreamedModelTurnRequest): Promise<any> {
    const run = async () => {
      let attemptedWithServerHistory = false;
      try {
        const preparedRequest = this.#prepareCodexServerHistoryRequests(request);
        attemptedWithServerHistory = Boolean(
          preparedRequest.warmupRequest || preparedRequest.request?.previousResponseId,
        );
        const warmupResponseId = await this.#warmupCodexUnary(preparedRequest.warmupRequest);
        const effectiveRequest = this.#getEffectiveCodexRequestAfterWarmup(request, preparedRequest, warmupResponseId);

        const response = await super.fetchUnaryResponse(effectiveRequest);
        const responseId = getResponseIdFromResponse(response);
        this.#rememberCodexResponseId(responseId, asRecord(response)?.output, effectiveRequest.input);
        this.#rememberConsumedToolResultCallIds(
          responseId,
          effectiveRequest.previousResponseId,
          effectiveRequest.input,
        );
        return response;
      } catch (error) {
        if (isPreviousResponseUnavailableError(error) && attemptedWithServerHistory) {
          this.#forgetCodexResponseId();
          if (isPreviousResponseUnavailableError(error) && hasToolResultInput(request)) {
            throw error;
          }
          const fallbackRequest = this.#withoutCodexServerHistory(request);
          const response = await super.fetchUnaryResponse(fallbackRequest);
          const responseId = getResponseIdFromResponse(response);
          this.#rememberCodexResponseId(responseId, asRecord(response)?.output, fallbackRequest.input);
          this.#rememberConsumedToolResultCallIds(responseId, undefined, fallbackRequest.input);
          return response;
        }
        if (this.#shouldForgetCodexServerHistory(error)) {
          this.#forgetCodexResponseId();
        }
        throw asAmbiguousModelOutcome(error) ?? error;
      }
    };

    return run();
  }

  protected override async *rawStream(request: StreamedModelTurnRequest): AsyncIterable<any> {
    let receivedRawFrame = false;
    let attemptedWithServerHistory = false;
    try {
      const preparedRequest = this.#prepareCodexServerHistoryRequests(request);
      attemptedWithServerHistory = Boolean(
        preparedRequest.warmupRequest || preparedRequest.request?.previousResponseId,
      );
      const warmupResponseId = await this.#warmupCodexStream(preparedRequest.warmupRequest);
      const effectiveRequest = this.#getEffectiveCodexRequestAfterWarmup(request, preparedRequest, warmupResponseId);

      let responseId: string | undefined;
      for await (const event of super.rawStream(effectiveRequest)) {
        const eventResponseId = getResponseIdFromStreamEvent(event);
        if (eventResponseId) {
          responseId = eventResponseId;
          this.#rememberCodexResponseId(responseId, getResponseOutputFromStreamEvent(event), effectiveRequest.input);
        }
        if (TERMINAL_RESPONSE_EVENT_TYPES.has(event?.type)) {
          this.#rememberConsumedToolResultCallIds(
            responseId,
            effectiveRequest.previousResponseId,
            effectiveRequest.input,
          );
        }
        receivedRawFrame = true;
        yield event;
      }
      this.#rememberConsumedToolResultCallIds(responseId, effectiveRequest.previousResponseId, effectiveRequest.input);
    } catch (error) {
      if (isPreviousResponseUnavailableError(error) && attemptedWithServerHistory && !receivedRawFrame) {
        this.#forgetCodexResponseId();
        if (isPreviousResponseUnavailableError(error) && hasToolResultInput(request)) {
          throw error;
        }
        const fallbackRequest = this.#withoutCodexServerHistory(request);
        let responseId: string | undefined;
        try {
          for await (const event of super.rawStream(fallbackRequest)) {
            receivedRawFrame = true;
            const eventResponseId = getResponseIdFromStreamEvent(event);
            if (eventResponseId) {
              responseId = eventResponseId;
              this.#rememberCodexResponseId(responseId, getResponseOutputFromStreamEvent(event), fallbackRequest.input);
            }
            if (TERMINAL_RESPONSE_EVENT_TYPES.has(event?.type)) {
              this.#rememberConsumedToolResultCallIds(responseId, undefined, fallbackRequest.input);
            }
            yield event;
          }
          this.#rememberConsumedToolResultCallIds(responseId, undefined, fallbackRequest.input);
          return;
        } catch (fallbackError) {
          throw asAmbiguousModelOutcome(fallbackError) ?? fallbackError;
        }
      }
      if (this.#shouldForgetCodexServerHistory(error)) {
        this.#forgetCodexResponseId();
      }
      throw asAmbiguousModelOutcome(error) ?? error;
    }
  }

  override buildResponsesCreateRequest(request: StreamedModelTurnRequest, stream: boolean): any {
    const built = super.buildResponsesCreateRequest(request, stream);
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

  protected override async fetchResponse(request: StreamedModelTurnRequest, stream: boolean): Promise<any> {
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

    const watchdog = createWebSocketReceiveWatchdog(request.signal, this.websocketReceiveTimeouts);
    const updatedRequest: StreamedModelTurnRequest = {
      ...request,
      signal: watchdog.signal,
      providerOptions: {
        ...request.providerOptions,
        ...(codexIdentity
          ? {
              client_metadata: {
                ...asRecord(request.providerOptions?.client_metadata),
                ...codexIdentity.clientMetadata,
              },
            }
          : {}),
        ...(isResponsesLite
          ? {
              client_metadata: {
                ...asRecord(request.providerOptions?.client_metadata),
                ...(codexIdentity?.clientMetadata ?? {}),
                ws_request_header_x_openai_internal_codex_responses_lite: 'true',
              },
            }
          : {}),
        extraHeaders: {
          ...asRecord(request.providerOptions?.extraHeaders),
          ...extraHeaders,
        },
      },
    };
    const builtRequest = this.buildResponsesCreateRequest(updatedRequest, true);
    const requestData = (asRecord(builtRequest?.requestData) ?? {}) as Record<string, unknown>;
    const wireStateToken = this.requestTokens.get(updatedRequest);
    // This is the last application-owned point before the inherited
    // transport's private fetch path. Capture it without changing the
    // prepared request or wire state.
    captureProviderRequest(this.requestCapture, { provider: 'codex', transport: 'websocket', requestData });
    this.#logTrafficStarted(requestId, requestData, extraHeaders);

    if (!stream) {
      try {
        const response = await fetchAndReconstructUnaryResponse(
          async () =>
            watchdog.wrap(await (super.fetchResponse(updatedRequest, true) as unknown as Promise<AsyncIterable<any>>)),
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
        const failure = timeoutError ?? error;
        if (wireStateKey) {
          if (isWebSocketConnectionLimitReachedError(failure)) {
            if (wireStateToken) this.chainedWireState.abandon(wireStateKey, wireStateToken);
          } else {
            this.chainedWireState.invalidate(wireStateKey);
          }
        }
        this.#logTrafficFailed(requestId, requestData, failure);
        throw failure;
      }
    }

    try {
      const response = (await super.fetchResponse(updatedRequest, stream)) as unknown as AsyncIterable<any>;
      const patched = wrapCodexStream(watchdog.wrap(response), this.diagnosticLogger);
      return this.#withTrafficLogging(
        patched,
        requestId,
        requestData,
        wireStateKey,
        wireStateToken,
        updatedRequest.signal,
      );
    } catch (error) {
      const timeoutError = watchdog.timeoutError();
      watchdog.close();
      const failure = timeoutError ?? error;
      if (wireStateKey) {
        if (isWebSocketConnectionLimitReachedError(failure)) {
          if (wireStateToken) this.chainedWireState.abandon(wireStateKey, wireStateToken);
        } else {
          this.chainedWireState.invalidate(wireStateKey);
        }
      }
      this.#logTrafficFailed(requestId, requestData, failure);
      throw failure;
    }
  }
}

export class CodexResponsesModel extends OpenAIResponsesModel {
  private readonly modelId: string;
  private readonly diagnosticLogger?: DiagnosticLogger;
  private readonly requestCapture?: ProviderRequestCapture;

  constructor(
    client: any,
    modelId: string,
    diagnosticLogger?: DiagnosticLogger | CodexResponsesTransport,
    requestCapture?: ProviderRequestCapture | CodexResponsesTransport,
    transport?: CodexResponsesTransport,
  ) {
    const candidates = [transport, diagnosticLogger, requestCapture];
    const injectedTransport = candidates.find(
      (candidate): candidate is CodexResponsesTransport => candidate instanceof CodexResponsesTransport,
    );
    super(client, modelId, injectedTransport);
    this.modelId = modelId;
    this.diagnosticLogger = diagnosticLogger instanceof CodexResponsesTransport ? undefined : diagnosticLogger;
    this.requestCapture = requestCapture instanceof CodexResponsesTransport ? undefined : requestCapture;
  }

  override buildResponsesCreateRequest(request: StreamedModelTurnRequest, stream: boolean): any {
    const built = super.buildResponsesCreateRequest(request, stream);

    const result = {
      ...built,
      requestData: normalizeCodexRequestData(built.requestData, request, this.modelId),
    };
    captureProviderRequest(this.requestCapture, {
      provider: 'codex',
      transport: 'http',
      requestData: result.requestData,
    });
    return result;
  }

  protected override async fetchResponse(request: StreamedModelTurnRequest, stream: boolean): Promise<any> {
    if (!stream) {
      return fetchAndReconstructUnaryResponse(() => super.fetchResponse(request, true), this.diagnosticLogger);
    }

    const response = await super.fetchResponse(request, stream);
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
      // from the itemCallIds map so the inherited transport's
      // convertToOutputItem picks up the correct identifier and the continuation
      // request sends the right call_id.
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
