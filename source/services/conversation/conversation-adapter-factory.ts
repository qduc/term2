import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { SessionRuntime } from '../session/session-composition.js';
import { ConversationAdapter } from './conversation-adapter.js';

export type CreateConversationAdapterOptions = {
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
};

export function createConversationAdapterForRuntime(
  runtime: SessionRuntime,
  { deps }: CreateConversationAdapterOptions,
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
  });
}
