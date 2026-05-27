import { OpenAIResponsesModel } from '@openai/agents-openai';
import { TimedResponsesWSModel } from './timed-responses-ws-model.js';

type DiagnosticLogger = {
  warn?: (message: string, meta?: Record<string, unknown>) => void;
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
    options: any = { connectTimeoutMs: 15_000, idleTimeoutMs: 300_000 },
  ) {
    super(client, model, options);
  }

  override _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = super._buildResponsesCreateRequest(request, stream);
    const requestData = { ...built.requestData };

    // Codex responses endpoint rejects temperature; always omit it.
    if ('temperature' in requestData) {
      delete requestData.temperature;
    }

    const modelInclude = request?.modelSettings?.include;
    if (Array.isArray(modelInclude) && modelInclude.length > 0) {
      const existingInclude = Array.isArray(requestData.include) ? requestData.include : [];
      requestData.include = Array.from(
        new Set([...existingInclude, ...modelInclude].filter((entry) => typeof entry === 'string' && entry.length > 0)),
      );
    }

    const promptCacheKey = request?.modelSettings?.prompt_cache_key;
    if (typeof promptCacheKey === 'string' && promptCacheKey.length > 0) {
      requestData.prompt_cache_key = promptCacheKey;
    }

    return {
      ...built,
      requestData,
    };
  }

  protected override async _fetchResponse(request: any, stream: boolean): Promise<any> {
    const accessToken = await this.tokenManager.getOrRefreshAccessToken();
    const accountId = this.tokenManager.getAccountId();

    const extraHeaders: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
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

    const response = await super._fetchResponse(updatedRequest, stream);
    if (!stream) return response;
    return wrapCodexStream(response, this.diagnosticLogger);
  }
}

export class CodexResponsesModel extends OpenAIResponsesModel {
  constructor(client: any, model: string, private readonly diagnosticLogger?: DiagnosticLogger) {
    super(client, model);
  }

  _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest.call(this, request, stream);
    const requestData = { ...built.requestData };

    // Codex responses endpoint rejects temperature; always omit it.
    if ('temperature' in requestData) {
      delete requestData.temperature;
    }

    const modelInclude = request?.modelSettings?.include;
    if (Array.isArray(modelInclude) && modelInclude.length > 0) {
      const existingInclude = Array.isArray(requestData.include) ? requestData.include : [];
      requestData.include = Array.from(
        new Set([...existingInclude, ...modelInclude].filter((entry) => typeof entry === 'string' && entry.length > 0)),
      );
    }

    const promptCacheKey = request?.modelSettings?.prompt_cache_key;
    if (typeof promptCacheKey === 'string' && promptCacheKey.length > 0) {
      requestData.prompt_cache_key = promptCacheKey;
    }

    return {
      ...built,
      requestData,
    };
  }

  async _fetchResponse(request: any, stream: boolean): Promise<any> {
    const response = await (OpenAIResponsesModel.prototype as any)._fetchResponse.call(this, request, stream);
    if (!stream) return response;
    return wrapCodexStream(response, this.diagnosticLogger);
  }
}

export async function* wrapCodexStream(source: AsyncIterable<any>, logger?: DiagnosticLogger): AsyncIterable<any> {
  let accumulatedItems: any[] = [];
  for await (let event of source) {
    const type = event?.type;
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
    }
    yield event;
  }
}
