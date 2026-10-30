import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import { createProviderFetch } from './fetch/composer.js';
export function buildProviderFetch(config, deps, middlewares) {
    const sessionContextService = deps.sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE;
    return createProviderFetch({
        providerId: config.name,
        defaultModel: (deps.defaultModel || '').trim(),
        deps: {
            loggingService: deps.loggingService ||
                {
                    debug: () => { },
                    error: () => { },
                    getCorrelationId: () => undefined,
                    info: () => { },
                    warn: () => { },
                    security: () => { },
                    setCorrelationId: () => { },
                    clearCorrelationId: () => { },
                },
            sessionContextService,
        },
        middlewares,
        fetchImpl: deps.fetch,
    });
}
//# sourceMappingURL=custom-provider-runtime.js.map