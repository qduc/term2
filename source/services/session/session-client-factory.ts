import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { PostExecutePendingRegistry } from './post-execute-pending-registry.js';
import { PostExecutePauseCapability } from './post-execute-pause-capability.js';

/** A client whose lifetime is owned by the session that requested it. */
export type SessionClientHandle = {
  readonly agentClient: ConversationAgentClient;
  readonly toolOwnership: ToolOwnershipRegistry;
  readonly postExecutePending?: PostExecutePendingRegistry;
  readonly postExecutePauseCapability?: PostExecutePauseCapability;
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
  createClient: (
    sessionId: string,
    toolOwnership: ToolOwnershipRegistry,
    postExecutePauseCapability: PostExecutePauseCapability,
  ) => DisposableConversationAgentClient,
): SessionClientFactory {
  return {
    create(sessionId) {
      const toolOwnership = new ToolOwnershipRegistry();
      const postExecutePending = new PostExecutePendingRegistry({ sessionId, epoch: crypto.randomUUID() });
      const postExecutePauseCapability = new PostExecutePauseCapability(postExecutePending);
      const agentClient = createClient(sessionId, toolOwnership, postExecutePauseCapability);
      let disposed = false;
      return {
        agentClient,
        toolOwnership,
        postExecutePending,
        postExecutePauseCapability,
        dispose() {
          if (disposed) return;
          disposed = true;
          agentClient.dispose?.();
          postExecutePauseCapability.setActiveRunId(null);
          postExecutePending.close();
          toolOwnership.clear();
        },
      };
    },
  };
}

/**
 * Compatibility seam for callers that provide a prebuilt client. Its owner
 * remains responsible for disposal, including across ConversationService reset.
 */
export function createCallerOwnedSessionClientFactory(
  agentClient: ConversationAgentClient,
  toolOwnership: ToolOwnershipRegistry,
): SessionClientFactory {
  return {
    create() {
      const postExecutePending = new PostExecutePendingRegistry({
        sessionId: 'caller-owned',
        epoch: crypto.randomUUID(),
      });
      return {
        agentClient,
        toolOwnership,
        postExecutePending,
        postExecutePauseCapability: new PostExecutePauseCapability(postExecutePending),
        dispose: () => {},
      };
    },
  };
}
