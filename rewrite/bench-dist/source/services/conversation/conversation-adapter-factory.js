import { ConversationAdapter } from './conversation-adapter.js';
import { createSessionQueuePersistence } from './queue-persistence.js';
import { isTestEnvironment } from '../settings/settings-env.js';
export function createConversationAdapterForRuntime(runtime, { deps, queueForeground, queueCapacity, preparedLeaseTtlMs, activeCancelTimeoutMs, discardOnFailure, sessionIdentity, awaitLogBoundary, }) {
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
        awaitLogBoundary,
        queuePersistence: queueForeground && !isTestEnvironment()
            ? createSessionQueuePersistence(sessionIdentity ?? runtime.sessionId)
            : undefined,
    });
}
//# sourceMappingURL=conversation-adapter-factory.js.map