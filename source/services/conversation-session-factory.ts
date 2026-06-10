import type { ILoggingService, ISessionContextService, ISettingsService } from './service-interfaces.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import {
  createConversationSessionComposition,
  type ConversationSessionRetryOptions,
} from './conversation-session-composition.js';
import type { ConversationTerminalAdapter } from './conversation-terminal-adapter.js';
import type { SessionStateFacade } from './session-state-facade.js';
import type { SessionRuntimeController } from './session-runtime-controller.js';
import type { ConversationLogger } from './conversation-logger.js';
import { ConversationSession } from './conversation-session.js';

// ── Options for the top-level session factory ─────────────────────

export type CreateConversationSessionOptions = {
  sessionId: string;
  /** ISO timestamp; defaults to now. */
  sessionStartedAt?: string;
  agentClient: ConversationAgentClient;
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
  retryOptions?: ConversationSessionRetryOptions;
};

/** Resources returned to callers (ConversationService, non-interactive, etc.). */
export type ConversationSessionBundle = {
  session: ConversationSession;
  terminalAdapter: ConversationTerminalAdapter;
  stateFacade: SessionStateFacade;
  runtimeController: SessionRuntimeController;
  conversationLogger: ConversationLogger;
  dispose: () => void;
};

/**
 * Production factory. Creates a ConversationSession together with all private
 * resources required by ConversationService, non-interactive, and subagent
 * callers. Use this instead of constructing ConversationSession directly.
 *
 * Interactive, non-interactive, and subagent paths all use this factory with
 * their respective profiles.
 */
export function createConversationSession(options: CreateConversationSessionOptions): ConversationSessionBundle {
  const { sessionId, sessionStartedAt, agentClient, deps, retryOptions } = options;
  const startedAt = sessionStartedAt ?? new Date().toISOString();

  const turnAccumulator = new TurnItemAccumulator();

  const composition = createConversationSessionComposition({
    sessionId,
    sessionStartedAt: startedAt,
    agentClient,
    deps,
    retryOptions,
    turnAccumulator,
  });

  const session = new ConversationSession(sessionId, {
    startedAt,
    composition,
  });

  return {
    session,
    terminalAdapter: composition.terminalAdapter,
    stateFacade: composition.stateFacade,
    runtimeController: composition.runtimeController,
    conversationLogger: composition.conversationLogger,
    dispose: composition.dispose,
  };
}
