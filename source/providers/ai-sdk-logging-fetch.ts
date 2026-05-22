import { randomUUID } from 'node:crypto';
import type { ILoggingService } from '../services/service-interfaces.js';
import { summarizeReceivedTraffic } from '../services/provider-traffic.js';

type FetchLike = typeof fetch;

type CreateAiSdkLoggingFetchOptions = {
  provider: string;
  model: string;
  loggingService: Pick<ILoggingService, 'debug' | 'error' | 'getCorrelationId' | 'getTrafficContext'>;
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
    const requestId = randomUUID();
    const trafficContext = loggingService.getTrafficContext?.() ?? null;
    const baseMeta = {
      requestId,
      traceId: trafficContext?.traceId ?? loggingService.getCorrelationId?.(),
      sessionId: trafficContext?.sessionId,
      sessionStartedAt: trafficContext?.sessionStartedAt,
      firstUserMessagePreview: trafficContext?.firstUserMessagePreview,
      mode: trafficContext?.mode,
      provider,
      model: requestModel,
    };

    const isEvaluator = trafficContext?.evaluator === true;
    const eventPrefix = isEvaluator ? 'evaluator' : 'provider';

    loggingService.debug(`${provider} ai sdk request`, {
      eventType: `${eventPrefix}.request.started`,
      category: 'provider',
      phase: 'request_start',
      direction: 'sent',
      ...baseMeta,
      messageCount: Array.isArray(parsedRequest?.messages) ? parsedRequest.messages.length : undefined,
      messages: parsedRequest?.messages,
      toolsCount: Array.isArray(parsedRequest?.tools) ? parsedRequest.tools.length : undefined,
      payload: parsedRequest ?? undefined,
    });

    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      loggingService.error(`${provider} ai sdk request failed`, {
        eventType: 'provider.response.failed',
        category: 'provider',
        phase: 'provider_response',
        ...baseMeta,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    Promise.resolve()
      .then(async () => {
        const summary = await summarizeReceivedTraffic(response.clone());
        loggingService.debug(`${provider} ai sdk response`, {
          eventType: `${eventPrefix}.response.received`,
          category: 'provider',
          phase: 'provider_response',
          direction: 'received',
          ...baseMeta,
          status: response.status,
          payload: summary,
        });
      })
      .catch((error) => {
        loggingService.debug(`${provider} ai sdk response log failed`, {
          eventType: 'provider.response.log_failed',
          category: 'provider',
          phase: 'provider_response',
          ...baseMeta,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return response;
  };
}
