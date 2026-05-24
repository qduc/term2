import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';

// Codex's `/backend-api/codex/responses` endpoint ships `response.completed`
// with an empty `output` array even when the assistant message was already
// delivered via `response.output_item.done`. The agents-SDK runner trusts
// `response.completed.response.output` as the final output; with an empty
// array it sees no items, decides the turn produced nothing, and re-runs the
// same request until maxTurns — an infinite-retry loop.
//
// This wrapper subclasses `OpenAIResponsesModel`, overrides the streaming
// fetch path, and patches the terminal frame in flight: it accumulates raw
// items from `response.output_item.done` and, only when the terminal
// `response.output` is empty, swaps in the accumulated items so the parent's
// existing conversion logic (`convertToOutputItem`) produces a normal
// `response_done` event.
export class CodexResponsesWSModel extends OpenAIResponsesWSModel {
  constructor(client: any, model: string, private readonly tokenManager: any, options?: any) {
    super(client, model, options);
  }

  _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest.call(this, request, stream);
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

    const response = await (OpenAIResponsesWSModel.prototype as any)._fetchResponse.call(this, updatedRequest, stream);
    if (!stream) return response;
    return wrapCodexStream(response);
  }
}

export class CodexResponsesModel extends OpenAIResponsesModel {
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
    return wrapCodexStream(response);
  }
}

export async function* wrapCodexStream(source: AsyncIterable<any>): AsyncIterable<any> {
  const accumulatedItems: any[] = [];
  for await (let event of source) {
    const type = event?.type;
    if (type === 'response.output_item.done' && event.item) {
      accumulatedItems.push(event.item);
    } else if (type === 'response.completed' && event.response) {
      const output = event.response.output;
      if (Array.isArray(output) && output.length === 0 && accumulatedItems.length > 0) {
        try {
          event.response.output = accumulatedItems;
        } catch {
          // Response object may be frozen; clone with the reconstructed output.
          event = { ...event, response: { ...event.response, output: accumulatedItems } };
        }
      }
    }
    yield event;
  }
}
