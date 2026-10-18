import type { ISettingsService, ILoggingService, ISessionContextService } from '../services/service-interfaces.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import { createProviderFetch } from './fetch/composer.js';
import type { FetchMiddleware } from './fetch/compose.js';

export type CustomProviderConfig = {
  name: string;
  label?: string;
  type?: string;
  baseUrl?: string;
  apiKey?: string;
};

export type CustomProviderRuntimeDeps = {
  defaultModel: string;
  fetch?: typeof fetch;
  loggingService?: ILoggingService;
  sessionContextService?: ISessionContextService;
  settingsService?: ISettingsService;
};

export function buildProviderFetch(
  config: CustomProviderConfig,
  deps: CustomProviderRuntimeDeps,
  middlewares: FetchMiddleware[],
): typeof fetch {
  const sessionContextService = deps.sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE;
  return createProviderFetch({
    providerId: config.name,
    defaultModel: (deps.defaultModel || '').trim(),
    deps: {
      loggingService:
        deps.loggingService ||
        ({
          debug: () => {},
          error: () => {},
          getCorrelationId: () => undefined,
          info: () => {},
          warn: () => {},
          security: () => {},
          setCorrelationId: () => {},
          clearCorrelationId: () => {},
        } as ILoggingService),
      sessionContextService,
    },
    middlewares,
    fetchImpl: deps.fetch,
  });
}
