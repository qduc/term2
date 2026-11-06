/** Per-application, asynchronous authority for one explicit CLI selection. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelRef } from '../model/index.js';
import type { DirectCommandConfiguration } from '../session/command-types.js';

type AuthorizeModel = (next: ModelRef, previous: ModelRef) => void | Promise<void>;

/** Effort and temperature are session-local; changing the model can change who gets billed. */
function sameModelOnly(next: ModelRef, previous: ModelRef): void {
  if (next.provider === previous.provider && next.model === previous.model) return;
  throw new Error('This client may not move the session to another model.');
}

export function createLaunchConfigurationScope(authorizeModel: AuthorizeModel = sameModelOnly) {
  const context = new AsyncLocalStorage<{ sessionId: string; configuration: DirectCommandConfiguration }>();
  return {
    authorizeModel,
    run<Result>(sessionId: string, configuration: DirectCommandConfiguration, operation: () => Promise<Result>) {
      return context.run({ sessionId, configuration }, operation);
    },
    active(sessionId: string): boolean {
      return context.getStore()?.sessionId === sessionId;
    },
    authorize(sessionId: string, next: ModelRef, previous: ModelRef): void | Promise<void> {
      const launch = context.getStore();
      const selected = launch?.sessionId === sessionId ? launch.configuration.model : undefined;
      if (selected && selected.provider === next.provider && selected.model === next.model) return;
      return authorizeModel(next, previous);
    },
  };
}
