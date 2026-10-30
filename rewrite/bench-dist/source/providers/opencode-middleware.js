import { createOpencodeSessionInjector } from './opencode-session.js';
/** Inject OpenCode session affinity for the configured endpoint across supported protocols. */
export function createOpencodeSessionMiddleware(identity, options) {
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
//# sourceMappingURL=opencode-middleware.js.map