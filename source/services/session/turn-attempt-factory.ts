import type { RunState } from '@openai/agents';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { AbortedApprovalContext } from '../approval/approval-state.js';
import type { GenerationGuard } from '../generation-guard.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { UserTurn } from '../../types/user-turn.js';
import { normalizeUserTurn } from '../../types/user-turn.js';
import type { SessionLifecycle } from './session-lifecycle.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import { TurnAttempt } from './turn-attempt.js';

export type InitialTurnRunOptions = {
  skipUserMessage?: boolean;
  replayFromHistory?: boolean;
  resumeState?: RunState<any, any>;
  resumePreviousResponseId?: string | null;
  abortedContext?: AbortedApprovalContext | null;
  token?: number;
  retries?: any;
  maxModelRetries?: number;
  signal?: AbortSignal;
  delayMs?: number;
  useStandardServiceTier?: boolean;
  bypassInputSurgeGuard?: boolean;
};

export type TurnAttemptFactoryDeps = {
  agentClient: ConversationAgentClient;
  conversationStore: ConversationStore;
  generationGuard: GenerationGuard;
  toolTracker: SessionToolTracker;
  state: SessionLifecycle;
  resolveRetryLimit: () => number;
  journal: AssistantTurnJournal;
};

export type TurnAttemptCreationResult = { kind: 'created'; attempt: TurnAttempt } | { kind: 'stale' };

export class TurnAttemptFactory {
  constructor(private readonly deps: TurnAttemptFactoryDeps) {}

  create(input: string | UserTurn, options: InitialTurnRunOptions = {}): TurnAttemptCreationResult {
    const normalized = normalizeUserTurn(input);
    let turn: UserTurn = this.deps.state.pendingModeNotice?.trim()
      ? { ...normalized, text: `${this.deps.state.pendingModeNotice}\n\n${normalized.text}` }
      : normalized;

    if (!turn.text && options.skipUserMessage && !options.replayFromHistory) {
      try {
        turn = { ...turn, text: this.deps.conversationStore.getLastUserMessage() };
      } catch {
        // A fresh-start retry can legitimately have no previous user message.
      }
    }

    const token = this.#resolveToken(options);
    if (token === null) {
      return { kind: 'stale' };
    }

    return {
      kind: 'created',
      attempt: new TurnAttempt({
        turn,
        token,
        initialRetryCounts: this.#normalizeRetryCounts(options.retries),
        initialJournalSnapshot: this.deps.journal.getEvents(),
        maxTransientRetries: this.deps.resolveRetryLimit(),
        maxModelRetries: options.maxModelRetries,
        signal: options.signal,
        onAbort: () => {
          this.deps.agentClient.abort();
        },
      }),
    };
  }

  #resolveToken(options: InitialTurnRunOptions): number | null {
    if (!options.abortedContext) {
      return options.token ?? this.deps.generationGuard.capture();
    }

    const token = options.abortedContext.token ?? 0;
    return this.deps.generationGuard.isCurrent(token) ? token : null;
  }

  #normalizeRetryCounts(retries: any): RetryCounts {
    const raw = retries ?? {};
    return {
      transientRetryCount: raw.transientRetryCount ?? 0,
      serviceTierFallbackCount: raw.serviceTierFallbackCount ?? raw.flexServiceTierFallbackCount ?? 0,
      modelRetryCount: raw.modelRetryCount ?? raw.hallucinationRetryCount ?? 0,
      transportDowngradeCount: raw.transportDowngradeCount ?? raw.transportFallbackRetryCount ?? 0,
    };
  }
}
