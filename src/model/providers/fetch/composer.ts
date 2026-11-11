import { composeFetch, FetchMiddleware } from './compose.js';
import { createLoggingMiddleware } from './logging-middleware.js';
import { createRateLimitMiddleware } from './rate-limit-middleware.js';
import type { ILoggingService, IProviderTraffic } from '../../../shared/service-interfaces.js';

const DUMMY_PROVIDER_TRAFFIC: IProviderTraffic = {
  recordRequestStart() {},
  // The logging middleware hands every recorder a clone of the response. A
  // clone nobody reads keeps the other branch's `cancel()` pending, and the
  // OpenAI client awaits that cancel when a stream fails part-way, so an
  // in-band provider error hung the turn instead of surfacing. Release it.
  //
  // A recorder that does read its copy still delays that cancel until the
  // server closes the stream; an in-band error on a connection the server holds
  // open waits for the user to cancel. Returning early instead aborts the
  // request under the recorder and loses its record of the error, so that case
  // is left as it is.
  async recordResponseReceived(input) {
    void Promise.resolve(input.response?.body?.cancel?.()).catch(() => {});
  },
  recordResponseClosed() {},
  recordRequestFailed() {},
};

export type CreateProviderFetchOptions = {
  providerId: string;
  defaultModel: string;
  deps: {
    loggingService: ILoggingService;
    sessionContextService?: any;
    onDispatched?: () => void;
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
  const dispatchFetch: typeof fetch = (input, init) => {
    const response = fetchImpl(input, init);
    deps.onDispatched?.();
    return response;
  };
  return composeFetch(dispatchFetch, [
    // Preprocessing and decorators execute first (outermost)
    ...middlewares,
    // Logging wraps rate-limit so it catches any errors thrown by the rate-limit check
    createLoggingMiddleware({
      provider: providerId,
      model: defaultModel,
      providerTraffic: deps.loggingService.providerTraffic ?? DUMMY_PROVIDER_TRAFFIC,
    }),
    // Rate-limit runs innermost so it checks the raw response and throws before
    // the SDK can process a 429 with retry-after > 60s
    createRateLimitMiddleware(),
  ]);
}
