/** Per-application, asynchronous authority for one explicit CLI selection. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelRef } from '../model/index.js';
import type { DirectAppConfiguration } from './config-settings.js';

/** `sessionId` names the session that would move, when the caller knows it. */
type AuthorizeModel = (next: ModelRef, previous: ModelRef, sessionId?: string) => void | Promise<void>;

/** Effort and temperature are session-local; changing the model can change who gets billed. */
function sameModelOnly(next: ModelRef, previous: ModelRef): void {
  if (next.provider === previous.provider && next.model === previous.model) return;
  throw new Error('This client may not move the session to another model.');
}

export function createLaunchConfigurationScope(authorizeModel: AuthorizeModel = sameModelOnly) {
  const context = new AsyncLocalStorage<{
    sessionId: string;
    configuration: DirectAppConfiguration;
    isLaunch: boolean;
  }>();
  return {
    authorizeModel,
    run<Result>(sessionId: string, configuration: DirectAppConfiguration, operation: () => Promise<Result>) {
      return context.run({ sessionId, configuration, isLaunch: true }, operation);
    },
    withApprovalMode<Result>(
      sessionId: string,
      approvalMode: NonNullable<DirectAppConfiguration['approvalMode']>,
      operation: () => Promise<Result>,
    ) {
      return context.run({ sessionId, configuration: { approvalMode }, isLaunch: false }, operation);
    },
    approvalMode(sessionId: string) {
      const launch = context.getStore();
      return launch?.sessionId === sessionId ? launch.configuration.approvalMode : undefined;
    },
    active(sessionId: string): boolean {
      const launch = context.getStore();
      return Boolean(launch?.sessionId === sessionId && launch.isLaunch);
    },
    authorize(sessionId: string, next: ModelRef, previous: ModelRef): void | Promise<void> {
      const launch = context.getStore();
      const selected = launch?.sessionId === sessionId && launch.isLaunch ? launch.configuration.model : undefined;
      if (selected && selected.provider === next.provider && selected.model === next.model) return;
      return authorizeModel(next, previous, sessionId);
    },
  };
}
