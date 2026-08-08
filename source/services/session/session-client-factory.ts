import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ContinuationProjectionMode } from '../../lib/continuation-projection-mode.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { PostExecutePendingRegistry } from './post-execute-pending-registry.js';
import { PostExecutePauseCapability } from './post-execute-pause-capability.js';
import { SessionAccessState } from './session-access-state.js';
import type { ISettingsService } from '../service-interfaces.js';
import { ProviderContinuity } from '../provider-continuity.js';
import { OpenAICandidateObserver } from '../openai-candidate-observer.js';
import {
  ProviderContinuityOpenAIRootSelectorParityObserver,
  type OpenAIRootFreshTurnSelectorParityObserver,
} from '../openai-root-selector-parity-observer.js';
import {
  DefaultOpenAIRootCheckpointLifecycleObserver,
  type OpenAIRootCheckpointLifecycleObserver,
} from '../openai-root-checkpoint-lifecycle-observer.js';
import { OpenAIRootProviderIdentity } from '../openai-root-provider-identity.js';
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import { HookEventFactory } from '../hooks/hook-event-factory.js';
import { createToolExecutionLifecyclePort } from '../hooks/hook-tool-lifecycle.js';
import type { ToolExecutionLifecyclePort } from '../../tools/types.js';
import { BackgroundShellRegistry } from '../shell/background-shell-registry.js';
import type { BackgroundShellExecutionResult } from '../../tools/system/shell.js';

/** A client whose lifetime is owned by the session that requested it. */
export type SessionClientHandle = {
  readonly agentClient: ConversationAgentClient;
  /** The sole continuity instance shared by this handle's root client and runtime. */
  readonly providerContinuity?: ProviderContinuity;
  /** Present only for an owned root session handle. */
  readonly openAIRootFreshTurnSelectorParityObserver?: OpenAIRootFreshTurnSelectorParityObserver;
  /** Present only for an owned root OpenAI session handle. */
  readonly openAIRootCheckpointLifecycleObserver?: OpenAIRootCheckpointLifecycleObserver;
  /** Compatibility selection fixed when this handle's client was created. */
  readonly continuationProjectionMode: ContinuationProjectionMode;
  readonly toolOwnership: ToolOwnershipRegistry;
  readonly access?: SessionAccessState;
  readonly postExecutePending?: PostExecutePendingRegistry;
  readonly postExecutePauseCapability?: PostExecutePauseCapability;
  readonly hookLifecycle?: HookLifecyclePort;
  readonly hookEvents?: HookEventFactory;
  readonly toolLifecycle?: ToolExecutionLifecyclePort;
  /** Present only for an owned root session handle. */
  readonly backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>;
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
    providerContinuity: ProviderContinuity,
    requestCapture: OpenAICandidateObserver,
    toolLifecycle?: ToolExecutionLifecyclePort,
    backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>,
  ) => DisposableConversationAgentClient,
  hookLifecycle?: HookLifecyclePort,
): SessionClientFactory {
  return {
    create(sessionId) {
      const continuationProjectionMode: ContinuationProjectionMode =
        settings.get('agent.provider') === 'openai' ? 'openai-provider' : 'legacy';
      const toolOwnership = new ToolOwnershipRegistry();
      const access = new SessionAccessState(settings);
      const postExecutePending = new PostExecutePendingRegistry({ sessionId, epoch: crypto.randomUUID() });
      const postExecutePauseCapability = new PostExecutePauseCapability(postExecutePending);
      const providerContinuity = new ProviderContinuity();
      const openAIRootCheckpointLifecycleObserver =
        continuationProjectionMode === 'openai-provider'
          ? new DefaultOpenAIRootCheckpointLifecycleObserver()
          : undefined;
      const openAIRootProviderIdentity = new OpenAIRootProviderIdentity();
      const requestCapture = new OpenAICandidateObserver(
        providerContinuity,
        openAIRootCheckpointLifecycleObserver,
        openAIRootProviderIdentity,
      );
      const hookEvents = hookLifecycle
        ? new HookEventFactory({
            sessionId,
            includeUserText: settings.getDynamic('hooks.includeUserText') === true,
            includeToolArguments: settings.getDynamic('hooks.includeToolArguments') === true,
            includeToolResults: settings.getDynamic('hooks.includeToolResults') === true,
          })
        : undefined;
      const toolLifecycle =
        hookLifecycle && hookEvents ? createToolExecutionLifecyclePort(hookLifecycle, hookEvents) : undefined;
      const backgroundShellRegistry = new BackgroundShellRegistry<BackgroundShellExecutionResult>();
      const openAIRootFreshTurnSelectorParityObserver =
        continuationProjectionMode === 'openai-provider'
          ? new ProviderContinuityOpenAIRootSelectorParityObserver(
              providerContinuity,
              () => settings.get('agent.model'),
              undefined,
              () => openAIRootProviderIdentity.current,
            )
          : undefined;
      const agentClient = createClient(
        sessionId,
        toolOwnership,
        postExecutePauseCapability,
        access,
        continuationProjectionMode,
        providerContinuity,
        requestCapture,
        toolLifecycle,
        backgroundShellRegistry,
      );
      let disposed = false;
      return {
        agentClient,
        providerContinuity,
        openAIRootFreshTurnSelectorParityObserver,
        openAIRootCheckpointLifecycleObserver,
        continuationProjectionMode,
        toolOwnership,
        access,
        postExecutePending,
        postExecutePauseCapability,
        hookLifecycle,
        hookEvents,
        toolLifecycle,
        backgroundShellRegistry,
        dispose() {
          if (disposed) return;
          disposed = true;
          agentClient.dispose?.();
          void backgroundShellRegistry.dispose();
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
      const providerContinuity = new ProviderContinuity();
      const postExecutePending = new PostExecutePendingRegistry({
        sessionId: 'caller-owned',
        epoch: crypto.randomUUID(),
      });
      return {
        agentClient,
        providerContinuity,
        continuationProjectionMode: 'legacy',
        toolOwnership,
        postExecutePending,
        postExecutePauseCapability: new PostExecutePauseCapability(postExecutePending),
        dispose: () => {},
      };
    },
  };
}
