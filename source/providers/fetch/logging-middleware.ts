import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ILoggingService, ISessionContextService } from '../../services/service-interfaces.js';
import { summarizeReceivedTraffic } from '../../services/logging/provider-traffic.js';
import { describeError } from '../../utils/error-helpers.js';
import { sanitizeHeaders } from '../../utils/header-sanitizer.js';
import type { FetchMiddleware } from './compose.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export let installationVersion = '0.6.1';
try {
  const packageJsonPath = join(__dirname, '../../../package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (pkg && typeof pkg.version === 'string') {
    installationVersion = pkg.version;
  }
} catch {
  // fallback
}

export type CreateLoggingMiddlewareOptions = {
  provider: string;
  model: string;
  loggingService: Pick<ILoggingService, 'debug' | 'error' | 'getCorrelationId'>;
  sessionContextService: ISessionContextService;
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

const extractResponseText = (body: Record<string, unknown> | null | undefined): string | undefined => {
  if (!body) return undefined;
  if (typeof body.output_text === 'string') {
    return body.output_text;
  }
  if (typeof body.text === 'string') {
    return body.text;
  }

  const choices = body.choices;
  if (Array.isArray(choices)) {
    const firstChoice = toRecord(choices[0]);
    const message = toRecord(firstChoice?.message);
    if (typeof message?.content === 'string') {
      return message.content;
    }
    const delta = toRecord(firstChoice?.delta);
    if (typeof delta?.content === 'string') {
      return delta.content;
    }
    if (typeof firstChoice?.text === 'string') {
      return firstChoice.text;
    }
  }

  return undefined;
};

const extractToolCalls = (body: Record<string, unknown> | null | undefined): unknown => {
  if (!body) return undefined;
  const choices = body.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }

  const firstChoice = toRecord(choices[0]);
  const message = toRecord(firstChoice?.message);
  const delta = toRecord(firstChoice?.delta);
  return message?.tool_calls ?? delta?.tool_calls;
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

/**
 * Merges newHeaders into an existing HeadersInit value.
 * Preserves the original structure type (Headers instance, array, or plain object).
 * Can be used by middlewares that need to inject or read headers.
 */
export function injectHeaders(initHeaders: HeadersInit | undefined, newHeaders: Record<string, string>): HeadersInit {
  if (!initHeaders) {
    return newHeaders;
  }

  if (typeof Headers !== 'undefined' && initHeaders instanceof Headers) {
    const headers = new Headers(initHeaders);
    for (const [key, value] of Object.entries(newHeaders)) {
      if (value) {
        headers.set(key, value);
      }
    }
    return headers;
  }

  if (Array.isArray(initHeaders)) {
    const headers = [...initHeaders] as [string, string][];
    for (const [key, value] of Object.entries(newHeaders)) {
      if (value) {
        const idx = headers.findIndex(([k]) => k.toLowerCase() === key.toLowerCase());
        if (idx !== -1) {
          headers[idx] = [key, value];
        } else {
          headers.push([key, value]);
        }
      }
    }
    return headers;
  }

  const headers = { ...(initHeaders as Record<string, string>) };
  for (const [key, value] of Object.entries(newHeaders)) {
    if (value) {
      const existingKey = Object.keys(headers).find((k) => k.toLowerCase() === key.toLowerCase());
      if (existingKey) {
        delete headers[existingKey];
      }
      headers[key] = value;
    }
  }
  return headers;
}

export function createLoggingMiddleware(options: CreateLoggingMiddlewareOptions): FetchMiddleware {
  const { provider, model, loggingService, sessionContextService } = options;

  return async (ctx, next) => {
    const requestBody = await readRequestBody(ctx.url, ctx.init);
    const parsedRequest = requestBody ? parseJsonObject(requestBody) : null;
    const requestModel = typeof parsedRequest?.model === 'string' ? parsedRequest.model : model;
    const requestId = randomUUID();
    const trafficContext = sessionContextService.getContext() ?? null;
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
    const sanitizedHeaders = ctx.init?.headers ? sanitizeHeaders(ctx.init.headers) : undefined;

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
      headers: sanitizedHeaders,
    });

    let response: Response;
    try {
      response = await next(ctx);
    } catch (error) {
      loggingService.error(`${provider} ai sdk request failed`, {
        eventType: `${eventPrefix}.response.failed`,
        category: 'provider',
        phase: 'provider_response',
        ...baseMeta,
        error: describeError(error),
      });
      throw error;
    }

    // Fire-and-forget async logging so it never blocks the caller
    Promise.resolve()
      .then(async () => {
        const summary = await summarizeReceivedTraffic(response.clone());
        const summaryPayload = toRecord(summary.payload);
        const responseText = summaryPayload
          ? extractResponseText(summaryPayload)
          : typeof summary.fallbackBody === 'string'
          ? summary.fallbackBody
          : undefined;
        const toolCalls = extractToolCalls(summaryPayload);

        loggingService.debug(`${provider} ai sdk response`, {
          eventType: `${eventPrefix}.response.received`,
          category: 'provider',
          phase: 'provider_response',
          direction: 'received',
          ...baseMeta,
          status: response.status,
          text: responseText,
          toolCalls,
          payload: summary,
        });
      })
      .catch((error) => {
        loggingService.debug(`${provider} ai sdk response log failed`, {
          eventType: `${eventPrefix}.response.log_failed`,
          category: 'provider',
          phase: 'provider_response',
          ...baseMeta,
          error: describeError(error),
        });
      });

    return response;
  };
}
