import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IProviderTraffic } from '../../../shared/service-interfaces.js';
import { sanitizeHeaders } from '../../../shared/utils/header-sanitizer.js';
import type { FetchMiddleware } from './compose.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export let installationVersion = '0.26.1';
try {
  let dir = __dirname;
  while (dir && dir !== dirname(dir)) {
    try {
      const packageJsonPath = join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (pkg && typeof pkg.version === 'string' && pkg.name === '@qduc/term2') {
        installationVersion = pkg.version;
        break;
      }
    } catch {
      // continue walking up
    }
    dir = dirname(dir);
  }
} catch {
  // fallback
}

export type CreateLoggingMiddlewareOptions = {
  provider: string;
  model: string;
  providerTraffic: IProviderTraffic;
  timeoutMs?: number;
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
  const { provider, model, providerTraffic, timeoutMs } = options;
  let physicalAttempt = 0;
  const attemptsBySignal = new WeakMap<AbortSignal, number>();

  return async (ctx, next) => {
    const requestBody = await readRequestBody(ctx.url, ctx.init);
    const parsedRequest = requestBody ? parseJsonObject(requestBody) : null;
    const requestModel = typeof parsedRequest?.model === 'string' ? parsedRequest.model : model;
    const requestId = randomUUID();
    const attempt = attemptForSignal(ctx.init?.signal, attemptsBySignal, () => ++physicalAttempt);
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
        host: hostFromRequest(ctx.url),
        timeoutMs,
        phase: 'request',
        physicalAttempt: attempt,
      });
      throw error;
    }

    // The recorder reads its own copy of the body. Taken before the caller's
    // copy is rewrapped below, while the body is still unlocked.
    const recorded = response.clone();
    // Fire-and-forget async logging so it never blocks the caller
    Promise.resolve()
      .then(async () => {
        await providerTraffic.recordResponseReceived({
          requestId,
          provider,
          model: requestModel,
          status: response.status,
          response: recorded,
        });
      })
      .catch((error: unknown) => {
        // Response headers only prove that the request reached the provider;
        // the body can still reject while the AI SDK consumes an SSE stream.
        // Finish the same request envelope with the original sanitized failure
        // path instead of leaving `{ received: {} }` behind. This remains
        // fire-and-forget: diagnostic failure must never affect the provider
        // consumer, and recordRequestFailed itself is fail-open.
        try {
          providerTraffic.recordRequestFailed({
            requestId,
            provider,
            model: requestModel,
            error,
            host: hostFromRequest(ctx.url),
            timeoutMs,
            phase: 'response',
            physicalAttempt: attempt,
          });
        } catch {
          // Safe catch for a custom/test traffic sink that is not fail-open.
        }
      });

    return withDetachedCancel(response);
  };
}

/**
 * Returns `response` with a body whose `cancel()` settles at once.
 *
 * Cloning tees the body, and cancelling one tee branch does not settle until
 * the other branch is cancelled or the source ends. The OpenAI client awaits
 * that cancel when a stream fails part-way, before it aborts the request. With
 * the recorder still reading its copy and a server that keeps the connection
 * open after an in-band error, the await never returned and the turn hung. The
 * caller's cancel is still forwarded; it is only no longer waited on, so the
 * client goes on to abort the request, which ends the recorder's copy too.
 */
function withDetachedCancel(response: Response): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
  const detached = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // A constructed Response has no URL; callers that log or branch on it keep the original.
  Object.defineProperty(detached, 'url', { value: response.url });
  return detached;
}

function attemptForSignal(
  signal: AbortSignal | null | undefined,
  attempts: WeakMap<AbortSignal, number>,
  nextUnscoped: () => number,
): number {
  if (!signal) return nextUnscoped();
  const next = (attempts.get(signal) ?? 0) + 1;
  attempts.set(signal, next);
  return next;
}

function hostFromRequest(input: RequestInfo | URL): string | undefined {
  try {
    const url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : new URL(input.url);
    return url.hostname;
  } catch {
    return undefined;
  }
}
