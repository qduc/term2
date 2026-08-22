import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type {
  AskUserAnswerSink,
  ConversationAgentClient,
  SubagentEventSinkHost,
} from '../conversation-agent-client.js';
import { createSessionRuntime, type SessionRuntime } from '../../core/index.js';
import { createConversationAdapterForRuntime } from './conversation-adapter-factory.js';
import type { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import type { PostExecutePendingRegistry } from '../session/post-execute-pending-registry.js';
import type { PostExecutePauseCapability } from '../session/post-execute-pause-capability.js';
import type { SessionAccessState } from '../session/session-access-state.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { OpenAIRootFreshTurnSelectorParityObserver } from '../openai-root-selector-parity-observer.js';
import type { OpenAIRootCheckpointLifecycleObserver } from '../openai-root-checkpoint-lifecycle-observer.js';
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import type { HookEventFactory } from '../hooks/hook-event-factory.js';
import type { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';

export type ConversationRuntimeBundle = {
  /** The clean session runtime (no adapter). */
  runtime: SessionRuntime;
  /** The legacy ConversationAdapter wired to the runtime's turn flow. */
  adapter: import('./conversation-adapter.js').ConversationAdapter;
};

export type CreateConversationRuntimeOptions = {
  /** Enables serialized foreground submissions for the ConversationService facade. */
  queueForeground?: boolean;
  /** Gateway-only finite queue capacity. Legacy callers remain unlimited. */
  queueCapacity?: number;
  /** Gateway-only prepared admission lease TTL. */
  preparedLeaseTtlMs?: number;
  activeCancelTimeoutMs?: number;
  discardOnFailure?: boolean;
  sessionId: string;
  /** ISO timestamp; defaults to now. */
  sessionStartedAt?: string;
  agentClient: ConversationAgentClient;
  providerContinuity?: ProviderContinuity;
  openAIRootFreshTurnSelectorParityObserver?: OpenAIRootFreshTurnSelectorParityObserver;
  openAIRootCheckpointLifecycleObserver?: OpenAIRootCheckpointLifecycleObserver;
  toolOwnership: ToolOwnershipRegistry;
  postExecutePending?: PostExecutePendingRegistry;
  postExecutePauseCapability?: PostExecutePauseCapability;
  sessionAccess?: SessionAccessState;
  askUserAnswerSink?: AskUserAnswerSink | null;
  subagentEventSinkHost?: SubagentEventSinkHost | null;
  hookLifecycle?: HookLifecyclePort;
  hookEvents?: HookEventFactory;
  toolCallMarkers?: ToolCallMarkerStore;
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
};

/**
 * Factory that assembles a session runtime and a ConversationAdapter.
 *
 * - Calls {@link createSessionRuntime} to build the session runtime once.
 * - Constructs the legacy adapter in the conversation layer from the same
 *   closed runtime instance.
 *
 * Returns `{ runtime, adapter }` so callers can use whichever layer suits them.
 */
export function createConversationRuntime(options: CreateConversationRuntimeOptions): ConversationRuntimeBundle {
  const runtime = createSessionRuntime(options);
  const adapter = createConversationAdapterForRuntime(runtime, {
    deps: options.deps,
    queueForeground: options.queueForeground,
    queueCapacity: options.queueCapacity,
    preparedLeaseTtlMs: options.preparedLeaseTtlMs,
    activeCancelTimeoutMs: options.activeCancelTimeoutMs,
    discardOnFailure: options.discardOnFailure,
  });

  return { runtime, adapter };
}
