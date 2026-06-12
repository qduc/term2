import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import type {
  AskUserAnswerSink,
  ConversationAgentClient,
  SubagentEventSinkHost,
} from '../conversation-agent-client.js';
import { createConversationSessionComposition, type ConversationSessionRetryOptions } from './session-composition.js';
import type { ConversationAdapter } from '../conversation/conversation-adapter.js';
import type { SessionManager } from './session-manager.js';
import type { SessionRuntimeController } from './session-runtime-controller.js';
import type { ConversationLogger } from '../logging/conversation-logger.js';
import type { ApprovalState } from '../approval/approval-state.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import { ConversationSession } from './conversation-session.js';

const asAskUserAnswerSink = (value: unknown): AskUserAnswerSink | null =>
  value && typeof (value as AskUserAnswerSink).setAskUserAnswer === 'function' ? (value as AskUserAnswerSink) : null;

const asSubagentEventSinkHost = (value: unknown): SubagentEventSinkHost | null =>
  value && typeof (value as SubagentEventSinkHost).setSubagentEventSink === 'function'
    ? (value as SubagentEventSinkHost)
    : null;

// ── Options for the top-level session factory ─────────────────────

export type CreateConversationSessionOptions = {
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
  retryOptions?: ConversationSessionRetryOptions;
};

/** Resources returned to callers (ConversationService, non-interactive, etc.). */
export type ConversationSessionBundle = {
  session: ConversationSession;
  terminalAdapter: ConversationAdapter;
  stateFacade: SessionManager;
  runtimeController: SessionRuntimeController;
  conversationLogger: ConversationLogger;
  approvalState: ApprovalState;
  shellAutoApproval: ShellAutoApprovalResolver;
  toolTracker: SessionToolTracker;
  inputPlanner: SessionInputPlanner;
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
  const {
    sessionId,
    sessionStartedAt,
    agentClient,
    askUserAnswerSink = null,
    subagentEventSinkHost = null,
    deps,
    retryOptions,
  } = options;
  const startedAt = sessionStartedAt ?? new Date().toISOString();

  const turnAccumulator = new TurnItemAccumulator();

  const composition = createConversationSessionComposition({
    sessionId,
    sessionStartedAt: startedAt,
    agentClient,
    askUserAnswerSink: askUserAnswerSink ?? asAskUserAnswerSink(agentClient),
    subagentEventSinkHost: subagentEventSinkHost ?? asSubagentEventSinkHost(agentClient),
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
    approvalState: composition.approvalState,
    shellAutoApproval: composition.shellAutoApproval,
    toolTracker: composition.toolTracker,
    inputPlanner: composition.inputPlanner,
    dispose: composition.dispose,
  };
}
