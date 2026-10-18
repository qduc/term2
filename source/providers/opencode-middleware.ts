import type { ISessionContextService } from '../services/service-interfaces.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { createOpencodeSessionInjector } from './opencode-session.js';
import type { OpencodeProviderIdentity } from './opencode.provider.js';

/** Inject OpenCode session affinity for the configured endpoint across supported protocols. */
export function createOpencodeSessionMiddleware(
  identity: OpencodeProviderIdentity,
  options?: {
    sessionContextService?: ISessionContextService;
    fallbackSessionIdOverride?: string;
  },
): FetchMiddleware {
  const injectSession = createOpencodeSessionInjector(identity, options);

  return async (ctx, next) => {
    if (injectSession) {
      const newInit = injectSession(ctx.init ?? {});
      if (newInit) {
        return next({ url: ctx.url, init: newInit });
      }
    }

    return next(ctx);
  };
}
