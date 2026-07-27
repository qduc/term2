import type { ConversationAgentClient } from '../conversation-agent-client.js';

/** A client whose lifetime is owned by the session that requested it. */
export type SessionClientHandle = {
  readonly agentClient: ConversationAgentClient;
  /** Idempotently release resources captured by this session's client. */
  dispose(): void;
};

/** Creates the closure-bound client for one conversation session. */
export type SessionClientFactory = {
  create(sessionId: string): SessionClientHandle;
};

type DisposableConversationAgentClient = ConversationAgentClient & { dispose?: () => void };

/**
 * Makes a factory for production clients. Each handle owns exactly the client
 * it creates, so replacement sessions cannot retain a prior closure-bound
 * client or its subscriptions.
 */
export function createOwnedSessionClientFactory(
  createClient: (sessionId: string) => DisposableConversationAgentClient,
): SessionClientFactory {
  return {
    create(sessionId) {
      const agentClient = createClient(sessionId);
      let disposed = false;
      return {
        agentClient,
        dispose() {
          if (disposed) return;
          disposed = true;
          agentClient.dispose?.();
        },
      };
    },
  };
}

/**
 * Compatibility seam for callers that provide a prebuilt client. Its owner
 * remains responsible for disposal, including across ConversationService reset.
 */
export function createCallerOwnedSessionClientFactory(agentClient: ConversationAgentClient): SessionClientFactory {
  return {
    create() {
      return { agentClient, dispose: () => {} };
    },
  };
}
