import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IProviderTraffic } from '../../services/service-interfaces.js';
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
  providerTraffic: IProviderTraffic;
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
  const { provider, model, providerTraffic } = options;

  return async (ctx, next) => {
    const requestBody = await readRequestBody(ctx.url, ctx.init);
    const parsedRequest = requestBody ? parseJsonObject(requestBody) : null;
    const requestModel = typeof parsedRequest?.model === 'string' ? parsedRequest.model : model;
    const requestId = randomUUID();
    const sanitizedHeaders = ctx.init?.headers ? sanitizeHeaders(ctx.init.headers) : undefined;

    providerTraffic.recordRequestStart({
      requestId,
      provider,
      model: requestModel,
      sentBody: parsedRequest ?? {},
      headers: sanitizedHeaders,
    });

    let response: Response;
    try {
      response = await next(ctx);
    } catch (error) {
      providerTraffic.recordRequestFailed({
        requestId,
        provider,
        model: requestModel,
        error,
      });
      throw error;
    }

    // Fire-and-forget async logging so it never blocks the caller
    Promise.resolve()
      .then(async () => {
        await providerTraffic.recordResponseReceived({
          requestId,
          provider,
          model: requestModel,
          status: response.status,
          response: response.clone(),
        });
      })
      .catch(() => {
        // Safe catch for fire-and-forget
      });

    return response;
  };
}
