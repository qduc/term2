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
import { createConversationAdapterForComposition } from './conversation-adapter-factory.js';

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
 * - Calls {@link createConversationSessionComposition} to build the session
 *   internal composition graph once.
 * - Wraps the composition into a public {@link SessionRuntime} object.
 * - Constructs the legacy adapter in the conversation layer.
 *
 * Returns `{ runtime, adapter }` so callers can use whichever layer suits them.
 */
export function createConversationRuntime(options: CreateConversationRuntimeOptions): ConversationRuntimeBundle {
  const { sessionId, sessionStartedAt, agentClient, deps } = options;

  const composition = createConversationSessionComposition({
    sessionId,
    sessionStartedAt,
    agentClient,
    askUserAnswerSink: options.askUserAnswerSink,
    subagentEventSinkHost: options.subagentEventSinkHost,
    deps,
    turnAccumulator: undefined,
  });

  const runtime: SessionRuntime = buildRuntimeFromComposition(composition);
  const adapter = createConversationAdapterForComposition(composition, { deps });

  return { runtime, adapter };
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
