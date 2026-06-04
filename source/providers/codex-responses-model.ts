import { OpenAIResponsesModel } from '@openai/agents-openai';
import { TimedResponsesWSModel } from './timed-responses-ws-model.js';
import { DEFAULT_TIMED_WS_TIMEOUTS } from './timed-ws-timeouts.js';

type DiagnosticLogger = {
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

function normalizeCodexRequestData(requestData: any, request: any): any {
  const normalizedRequestData = { ...requestData };

  // Codex responses endpoint rejects temperature; always omit it.
  if ('temperature' in normalizedRequestData) {
    delete normalizedRequestData.temperature;
  }

  normalizedRequestData.input = stripCodexReplayIds(normalizedRequestData.input);

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
export class CodexResponsesWSModel extends TimedResponsesWSModel {
  constructor(
    client: any,
    model: string,
    private readonly tokenManager: any,
    private readonly diagnosticLogger?: DiagnosticLogger,
    options: any = DEFAULT_TIMED_WS_TIMEOUTS,
  ) {
    super(client, model, options);
  }

  override _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = super._buildResponsesCreateRequest(request, stream);

    return {
      ...built,
      requestData: normalizeCodexRequestData(built.requestData, request),
    };
  }

  protected override async _fetchResponse(request: any, stream: boolean): Promise<any> {
    const accessToken = await this.tokenManager.getOrRefreshAccessToken();
    const accountId = this.tokenManager.getAccountId();

    const extraHeaders: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
    };
    if (accountId) {
      extraHeaders['chatgpt-account-id'] = accountId;
    }

    const updatedRequest = {
      ...request,
      modelSettings: {
        ...request.modelSettings,
        providerData: {
          ...request.modelSettings?.providerData,
          extraHeaders: {
            ...request.modelSettings?.providerData?.extraHeaders,
            ...extraHeaders,
          },
        },
      },
    };

    if (!stream) {
      return fetchAndReconstructUnaryResponse(() => super._fetchResponse(updatedRequest, true), this.diagnosticLogger);
    }

    const response = await super._fetchResponse(updatedRequest, stream);
    return wrapCodexStream(response, this.diagnosticLogger);
  }
}

export class CodexResponsesModel extends OpenAIResponsesModel {
  constructor(client: any, model: string, private readonly diagnosticLogger?: DiagnosticLogger) {
    super(client, model);
  }

  _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest.call(this, request, stream);

    return {
      ...built,
      requestData: normalizeCodexRequestData(built.requestData, request),
    };
  }

  async _fetchResponse(request: any, stream: boolean): Promise<any> {
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
  for await (let event of source) {
    const type = event?.type;
    if (type === 'response.error' && event.error) {
      const errMsg = event.error.message || JSON.stringify(event.error);
      logger?.error?.('Codex stream received response.error event', {
        eventType: 'codex.response.stream_error_event',
        error: event.error,
      });
      throw new Error(`Codex provider stream error: ${errMsg}`);
    }

    if (type === 'response.output_item.done' && event.item) {
      accumulatedItems.push(event.item);
    } else if (TERMINAL_RESPONSE_EVENT_TYPES.has(type) && event.response) {
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
