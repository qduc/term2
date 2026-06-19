import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type {
  AskUserAnswerSink,
  ConversationAgentClient,
  SubagentEventSinkHost,
} from '../conversation-agent-client.js';
import {
  createConversationSessionComposition,
  type ConversationSessionComposition,
  type SessionRuntime,
} from '../session/session-composition.js';

export type ConversationRuntimeBundle = {
  /** The clean session runtime (no adapter). */
  runtime: SessionRuntime;
  /** The legacy ConversationAdapter wired to the runtime's turn flow. */
  adapter: import('./conversation-adapter.js').ConversationAdapter;
};

export type CreateConversationRuntimeOptions = {
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
 * - Calls {@link createConversationSessionComposition} to build the full
 *   internal composition graph once (which includes the adapter).
 * - Wraps the composition into a public {@link SessionRuntime} object.
 * - Returns the composition's pre-built adapter alongside the runtime.
 *
 * Returns `{ runtime, adapter }` so callers can use whichever layer suits them.
 */
export function createConversationRuntime(options: CreateConversationRuntimeOptions): ConversationRuntimeBundle {
  const { sessionId, sessionStartedAt, agentClient, deps } = options;

  // The composition already constructs the ConversationAdapter.
  const composition = createConversationSessionComposition({
    sessionId,
    sessionStartedAt,
    agentClient,
    askUserAnswerSink: options.askUserAnswerSink,
    subagentEventSinkHost: options.subagentEventSinkHost,
    deps,
    turnAccumulator: undefined,
  });

  // Build the public SessionRuntime from the composition.
  const runtime: SessionRuntime = buildRuntimeFromComposition(composition);

  return { runtime, adapter: composition.terminalAdapter };
}

// ── Internal helper ──────────────────────────────────────────────

function buildRuntimeFromComposition(comp: ConversationSessionComposition): SessionRuntime {
  return {
    sessionId: comp.sessionId,
    sessionStartedAt: comp.sessionStartedAt,
    turns: {
      start: comp.turnCoordinator.start.bind(comp.turnCoordinator),
      continueAfterApproval: comp.turnCoordinator.continueAfterApproval.bind(comp.turnCoordinator),
      abort: comp.turnCoordinator.abort.bind(comp.turnCoordinator),
    },
    state: comp.stateFacade,
    settings: comp.runtimeController,
    logs: {
      setLogSink: (sink) => {
        comp.conversationLogger.setLogSink(sink);
        if (sink) {
          comp.ensureJournal(sink);
        }
      },
    },
    dispose: comp.dispose,
  };
}
