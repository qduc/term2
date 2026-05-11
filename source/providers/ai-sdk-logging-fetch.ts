import type { ILoggingService } from '../services/service-interfaces.js';
import { truncateLogText } from '../utils/log-truncation.js';

type FetchLike = typeof fetch;

type CreateAiSdkLoggingFetchOptions = {
  provider: string;
  model: string;
  loggingService: Pick<ILoggingService, 'debug' | 'error' | 'getCorrelationId'>;
  fetchImpl?: FetchLike;
};

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const parseJsonObject = (raw: string): Record<string, unknown> | null => {
  try {
    return toRecord(JSON.parse(raw));
  } catch {
    return null;
  }
};

const readRequestBody = async (input: RequestInfo | URL, init?: RequestInit): Promise<string | null> => {
  if (typeof init?.body === 'string') {
    return init.body;
  }

  if (init?.body instanceof URLSearchParams) {
    return init.body.toString();
  }

  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }

  return null;
};

const extractResponseText = (body: Record<string, unknown>): string | undefined => {
  const outputText = body.output_text;
  if (typeof outputText === 'string') {
    return outputText;
  }

  const choices = body.choices;
  if (Array.isArray(choices)) {
    const firstChoice = toRecord(choices[0]);
    const message = toRecord(firstChoice?.message);
    if (typeof message?.content === 'string') {
      return message.content;
    }
    if (typeof firstChoice?.text === 'string') {
      return firstChoice.text;
    }
  }

  return undefined;
};

const extractToolCalls = (body: Record<string, unknown>): unknown => {
  const choices = body.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }

  const firstChoice = toRecord(choices[0]);
  const message = toRecord(firstChoice?.message);
  return message?.tool_calls;
};

export function createAiSdkLoggingFetch({
  provider,
  model,
  loggingService,
  fetchImpl = fetch,
}: CreateAiSdkLoggingFetchOptions): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestBody = await readRequestBody(input, init);
    const parsedRequest = requestBody ? parseJsonObject(requestBody) : null;
    const requestModel = typeof parsedRequest?.model === 'string' ? parsedRequest.model : model;

    loggingService.debug(`${provider} ai sdk request`, {
      eventType: 'provider.request.started',
      category: 'provider',
      phase: 'request_start',
      direction: 'sent',
      traceId: loggingService.getCorrelationId?.(),
      provider,
      model: requestModel,
      messageCount: Array.isArray(parsedRequest?.messages) ? parsedRequest.messages.length : undefined,
      messages: parsedRequest?.messages,
      toolsCount: Array.isArray(parsedRequest?.tools) ? parsedRequest.tools.length : undefined,
      tools: parsedRequest?.tools,
      modelRequest: parsedRequest ?? undefined,
    });

    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      loggingService.error(`${provider} ai sdk request failed`, {
        eventType: 'provider.response.failed',
        category: 'provider',
        phase: 'provider_response',
        traceId: loggingService.getCorrelationId?.(),
        provider,
        model: requestModel,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    response
      .clone()
      .text()
      .then((rawResponse) => {
        const parsedResponse = rawResponse ? parseJsonObject(rawResponse) : null;
        const responseText = parsedResponse ? extractResponseText(parsedResponse) : truncateLogText(rawResponse);
        loggingService.debug(`${provider} ai sdk response`, {
          eventType: 'provider.response.received',
          category: 'provider',
          phase: 'provider_response',
          direction: 'received',
          traceId: loggingService.getCorrelationId?.(),
          provider,
          model: requestModel,
          status: response.status,
          text: responseText,
          toolCalls: parsedResponse ? extractToolCalls(parsedResponse) : undefined,
          payload: parsedResponse ?? { rawPreview: truncateLogText(rawResponse) },
        });
      })
      .catch((error) => {
        loggingService.debug(`${provider} ai sdk response log failed`, {
          eventType: 'provider.response.log_failed',
          category: 'provider',
          phase: 'provider_response',
          traceId: loggingService.getCorrelationId?.(),
          provider,
          model: requestModel,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return response;
  };
}
