import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { ConversationSessionComposition } from '../session/session-composition.js';
import { ConversationAdapter } from './conversation-adapter.js';

export type CreateConversationAdapterOptions = {
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
};

export function createConversationAdapterForComposition(
  composition: ConversationSessionComposition,
  { deps }: CreateConversationAdapterOptions,
): ConversationAdapter {
  const { logger, settingsService, sessionContextService } = deps;
  return new ConversationAdapter({
    sessionId: composition.sessionId,
    startedAt: composition.sessionStartedAt,
    askUserAnswerSink: composition.resolvedAskUserAnswerSink,
    subagentEventSinkHost: composition.resolvedSubagentEventSinkHost,
    logger,
    settingsService,
    sessionContextService,
    conversationStore: composition.conversationStore,
    conversationLogger: composition.conversationLogger,
    approvalFlow: composition.approvalFlow,
    turnFlow: composition.turnCoordinator,
  });
}
