import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { GenerationGuard } from '../generation-guard.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { SessionLifecycle } from './session-lifecycle.js';
import type { TurnAttempt } from './turn-attempt.js';

type InputSurgeErrorEvent = Extract<ConversationEvent, { type: 'error' }>;

export type InitialInputPreparationResult = { kind: 'ready' } | { kind: 'blocked'; event: InputSurgeErrorEvent };

export type InitialInputPreparerDeps = {
  conversationStore: ConversationStore;
  generationGuard: GenerationGuard;
  inputPlanner: SessionInputPlanner;
  logger: ILoggingService;
  sessionId: string;
  state: SessionLifecycle;
};

export class InitialInputPreparer {
  constructor(private readonly deps: InitialInputPreparerDeps) {}

  prepare(
    attempt: TurnAttempt,
    skipUserMessage: boolean,
    options?: { bypassInputSurgeGuard?: boolean },
  ): InitialInputPreparationResult {
    if (!skipUserMessage && !attempt.addedUserMessage) {
      this.deps.conversationStore.addUserTurn(attempt.turn);
      attempt.markUserMessageAdded();
    }

    const plan = this.deps.inputPlanner.build(attempt.turn, {
      includeTurn: false,
      pendingModeNotice: this.deps.state.pendingModeNotice,
    });
    attempt.attachInput(plan);

    const surgeDecision = this.deps.inputPlanner.inspectForSurge(attempt.streamInput, attempt.inputMode!);
    if (surgeDecision.action === 'block' && !options?.bypassInputSurgeGuard) {
      let droppedUserMessage: { text: string; imageCount: number } | undefined;
      if (attempt.addedUserMessage && this.deps.generationGuard.isCurrent(attempt.token)) {
        this.deps.conversationStore.removeLastUserMessage();
        droppedUserMessage = { text: attempt.turn.text, imageCount: attempt.turn.images?.length ?? 0 };
      }

      this.deps.logger.warn('Input surge guard blocked provider request', {
        eventType: 'input_surge.blocked',
        category: 'provider',
        phase: 'request_start',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        reason: surgeDecision.reason,
        stats: surgeDecision.stats,
        previousStats: surgeDecision.previousStats,
      });

      return {
        kind: 'blocked',
        event: {
          type: 'error',
          kind: 'input_surge_guard',
          message: `${surgeDecision.reason} Request blocked to prevent runaway context growth. Try /undo or /clear, or compact the conversation history.`,
          ...(droppedUserMessage ? { droppedUserMessage } : {}),
        },
      };
    }

    if (this.deps.state.pendingModeNotice) {
      this.deps.state.pendingModeNotice = null;
    }
    return { kind: 'ready' };
  }
}
