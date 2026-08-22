import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { SessionRuntime } from '../../core/index.js';
import { ConversationAdapter } from './conversation-adapter.js';
import { createSessionQueuePersistence } from './queue-persistence.js';
import { isTestEnvironment } from '../settings/settings-env.js';

export type CreateConversationAdapterOptions = {
  queueForeground?: boolean;
  queueCapacity?: number;
  preparedLeaseTtlMs?: number;
  activeCancelTimeoutMs?: number;
  discardOnFailure?: boolean;
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
};

export function createConversationAdapterForRuntime(
  runtime: SessionRuntime,
  {
    deps,
    queueForeground,
    queueCapacity,
    preparedLeaseTtlMs,
    activeCancelTimeoutMs,
    discardOnFailure,
  }: CreateConversationAdapterOptions,
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
    pendingInteraction: runtime.pendingInteraction,
    turnFlow: runtime.turns,
    queueForeground,
    queueCapacity,
    preparedLeaseTtlMs,
    activeCancelTimeoutMs,
    discardOnFailure,
    queuePersistence:
      queueForeground && !isTestEnvironment() ? createSessionQueuePersistence(runtime.sessionId) : undefined,
  });
}
