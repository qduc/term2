import { AsyncLocalStorage } from 'node:async_hooks';
import type { ISessionContextService, SessionTrafficContext } from './service-interfaces.js';

export class SessionContextService implements ISessionContextService {
  readonly #storage = new AsyncLocalStorage<SessionTrafficContext>();

  runWithContext<T>(context: SessionTrafficContext, fn: () => T): T {
    return this.#storage.run(context, fn);
  }

  getContext(): SessionTrafficContext | null {
    return this.#storage.getStore() ?? null;
  }
}

export const NULL_SESSION_CONTEXT_SERVICE: ISessionContextService = {
  runWithContext<T>(_context: SessionTrafficContext, fn: () => T): T {
    return fn();
  },
  getContext(): SessionTrafficContext | null {
    return null;
  },
};
