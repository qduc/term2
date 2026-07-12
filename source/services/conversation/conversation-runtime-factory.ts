import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type {
  AskUserAnswerSink,
  ConversationAgentClient,
  SubagentEventSinkHost,
} from '../conversation-agent-client.js';
import { createSessionRuntime, type SessionRuntime } from '../session/session-composition.js';
import { createConversationAdapterForRuntime } from './conversation-adapter-factory.js';

export type ConversationRuntimeBundle = {
  /** The clean session runtime (no adapter). */
  runtime: SessionRuntime;
  /** The legacy ConversationAdapter wired to the runtime's turn flow. */
  adapter: import('./conversation-adapter.js').ConversationAdapter;
};

export type CreateConversationRuntimeOptions = {
  /** Enables serialized foreground submissions for the ConversationService facade. */
  queueForeground?: boolean;
  sessionId: string;
  /** ISO timestamp; defaults to now. */
  sessionStartedAt?: string;
  agentClient: ConversationAgentClient;
  askUserAnswerSink?: AskUserAnswerSink | null;
  subagentEventSinkHost?: SubagentEventSinkHost | null;
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
  });

  return { runtime, adapter };
}
