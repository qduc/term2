import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { SessionRuntime } from '../../core/index.js';
import { ConversationAdapter } from './conversation-adapter.js';
import { createSessionQueuePersistence } from './queue-persistence.js';
import { isTestEnvironment } from '../settings/settings-env.js';
import type { SessionIdentity } from '../session/session-identity.js';

export type CreateConversationAdapterOptions = {
  queueForeground?: boolean;
  queueCapacity?: number;
  preparedLeaseTtlMs?: number;
  activeCancelTimeoutMs?: number;
  discardOnFailure?: boolean;
  sessionIdentity?: SessionIdentity;
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
    sessionIdentity,
  }: CreateConversationAdapterOptions,
): ConversationAdapter {
  const { logger, settingsService, sessionContextService } = deps;
  return new ConversationAdapter({
    sessionId: sessionIdentity ?? runtime.sessionId,
    startedAt: sessionIdentity ?? runtime.sessionStartedAt,
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
