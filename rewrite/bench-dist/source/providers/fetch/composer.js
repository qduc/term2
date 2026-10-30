import { composeFetch } from './compose.js';
import { createLoggingMiddleware } from './logging-middleware.js';
import { createRateLimitMiddleware } from './rate-limit-middleware.js';
const DUMMY_PROVIDER_TRAFFIC = {
    recordRequestStart() { },
    async recordResponseReceived() { },
    recordResponseClosed() { },
    recordRequestFailed() { },
};
export function createProviderFetch({ providerId, defaultModel, deps, middlewares = [], fetchImpl = fetch, }) {
    return composeFetch(fetchImpl, [
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
//# sourceMappingURL=composer.js.map