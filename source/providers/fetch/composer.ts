import { composeFetch, FetchMiddleware } from './compose.js';
import { createLoggingMiddleware, CreateLoggingMiddlewareOptions } from './logging-middleware.js';
import { createRateLimitMiddleware } from './rate-limit-middleware.js';

export type CreateProviderFetchOptions = {
  providerId: string;
  defaultModel: string;
  deps: {
    loggingService: CreateLoggingMiddlewareOptions['loggingService'];
    sessionContextService: CreateLoggingMiddlewareOptions['sessionContextService'];
  };
  middlewares?: FetchMiddleware[];
  fetchImpl?: typeof fetch;
};

export function createProviderFetch({
  providerId,
  defaultModel,
  deps,
  middlewares = [],
  fetchImpl = fetch,
}: CreateProviderFetchOptions): typeof fetch {
  return composeFetch(fetchImpl, [
    // Preprocessing and decorators execute first (outermost)
    ...middlewares,
    // Logging wraps rate-limit so it catches any errors thrown by the rate-limit check
    createLoggingMiddleware({
      provider: providerId,
      model: defaultModel,
      loggingService: deps.loggingService,
      sessionContextService: deps.sessionContextService,
    }),
    // Rate-limit runs innermost so it checks the raw response and throws before
    // the SDK can process a 429 with retry-after > 60s
    createRateLimitMiddleware(),
  ]);
}
