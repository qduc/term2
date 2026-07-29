import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ContinuationProjectionMode } from '../../lib/continuation-projection-mode.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { PostExecutePendingRegistry } from './post-execute-pending-registry.js';
import { PostExecutePauseCapability } from './post-execute-pause-capability.js';
import { SessionAccessState } from './session-access-state.js';
import type { ISettingsService } from '../service-interfaces.js';

/** A client whose lifetime is owned by the session that requested it. */
export type SessionClientHandle = {
  readonly agentClient: ConversationAgentClient;
  /** Compatibility selection fixed when this handle's client was created. */
  readonly continuationProjectionMode: ContinuationProjectionMode;
  readonly toolOwnership: ToolOwnershipRegistry;
  readonly access?: SessionAccessState;
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
  settings: ISettingsService,
  createClient: (
    sessionId: string,
    toolOwnership: ToolOwnershipRegistry,
    postExecutePauseCapability: PostExecutePauseCapability,
    access: SessionAccessState,
    continuationProjectionMode: ContinuationProjectionMode,
  ) => DisposableConversationAgentClient,
): SessionClientFactory {
  return {
    create(sessionId) {
      const continuationProjectionMode: ContinuationProjectionMode =
        settings.get<string>('agent.provider') === 'openai' ? 'openai-provider' : 'legacy';
      const toolOwnership = new ToolOwnershipRegistry();
      const access = new SessionAccessState(settings);
      const postExecutePending = new PostExecutePendingRegistry({ sessionId, epoch: crypto.randomUUID() });
      const postExecutePauseCapability = new PostExecutePauseCapability(postExecutePending);
      const agentClient = createClient(
        sessionId,
        toolOwnership,
        postExecutePauseCapability,
        access,
        continuationProjectionMode,
      );
      let disposed = false;
      return {
        agentClient,
        continuationProjectionMode,
        toolOwnership,
        access,
        postExecutePending,
        postExecutePauseCapability,
        dispose() {
          if (disposed) return;
          disposed = true;
          agentClient.dispose?.();
          postExecutePauseCapability.setActiveRunId(null);
          postExecutePending.close();
          toolOwnership.clear();
          access.dispose();
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
        continuationProjectionMode: 'legacy',
        toolOwnership,
        postExecutePending,
        postExecutePauseCapability: new PostExecutePauseCapability(postExecutePending),
        dispose: () => {},
      };
    },
  };
}
