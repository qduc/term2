import { createSessionRuntime } from '../../core/session-runtime.js';
import { createConversationAdapterForRuntime } from './conversation-adapter-factory.js';
/**
 * Factory that assembles a session runtime and a ConversationAdapter.
 *
 * - Calls {@link createSessionRuntime} to build the session runtime once.
 * - Constructs the legacy adapter in the conversation layer from the same
 *   closed runtime instance.
 *
 * Returns `{ runtime, adapter }` so callers can use whichever layer suits them.
 */
export function createConversationRuntime(options) {
    const runtime = createSessionRuntime(options);
    const adapter = createConversationAdapterForRuntime(runtime, {
        deps: options.deps,
        queueForeground: options.queueForeground,
        queueCapacity: options.queueCapacity,
        preparedLeaseTtlMs: options.preparedLeaseTtlMs,
        activeCancelTimeoutMs: options.activeCancelTimeoutMs,
        discardOnFailure: options.discardOnFailure,
        sessionIdentity: options.sessionIdentity,
        awaitLogBoundary: options.awaitLogBoundary,
    });
    return { runtime, adapter };
}
//# sourceMappingURL=conversation-runtime-factory.js.map