import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { SessionRuntime } from '../session/session-composition.js';
import { ConversationAdapter } from './conversation-adapter.js';
import { createSessionQueuePersistence } from './queue-persistence.js';
import { isTestEnvironment } from '../settings/settings-env.js';

export type CreateConversationAdapterOptions = {
  queueForeground?: boolean;
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
};

export function createConversationAdapterForRuntime(
  runtime: SessionRuntime,
  { deps, queueForeground }: CreateConversationAdapterOptions,
): ConversationAdapter {
  const { logger, settingsService, sessionContextService } = deps;
  return new ConversationAdapter({
    sessionId: runtime.sessionId,
    startedAt: runtime.sessionStartedAt,
    askUserAnswerSink: runtime.sinks.askUserAnswer,
    subagentEventSinkHost: runtime.sinks.subagentEvents,
    logger,
    settingsService,
    sessionContextService,
    userTurns: runtime.state,
    logs: runtime.logs,
    approval: runtime.approval,
    turnFlow: runtime.turns,
    queueForeground,
    queuePersistence:
      queueForeground && !isTestEnvironment() ? createSessionQueuePersistence(runtime.sessionId) : undefined,
  });
}
