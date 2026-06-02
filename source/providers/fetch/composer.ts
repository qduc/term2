import { composeFetch, FetchMiddleware } from './compose.js';
import { createLoggingMiddleware, CreateLoggingMiddlewareOptions } from './logging-middleware.js';

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
    // Logging runs last, so it logs the final mutated request
    createLoggingMiddleware({
      provider: providerId,
      model: defaultModel,
      loggingService: deps.loggingService,
      sessionContextService: deps.sessionContextService,
    }),
  ]);
}
