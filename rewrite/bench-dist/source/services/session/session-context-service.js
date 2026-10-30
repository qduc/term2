import { AsyncLocalStorage } from 'node:async_hooks';
export class SessionContextService {
    #storage = new AsyncLocalStorage();
    runWithContext(context, fn) {
        return this.#storage.run(context, fn);
    }
    getContext() {
        return this.#storage.getStore() ?? null;
    }
}
export const NULL_SESSION_CONTEXT_SERVICE = {
    runWithContext(_context, fn) {
        return fn();
    },
    getContext() {
        return null;
    },
};
//# sourceMappingURL=session-context-service.js.map