import { type RunState } from '@openai/agents';
import type { ConversationEvent } from './conversation-events.js';
import type { UserTurn } from '../types/user-turn.js';
import {
  type ConversationSessionComposition,
  type ConversationSessionRetryOptions,
} from './conversation-session-composition.js';

export type ConversationResult = import('../contracts/conversation.js').ConversationTerminal;
export type { ConversationSessionRetryOptions };

export class ConversationSession {
  public readonly id: string;
  public readonly startedAt: string;

  readonly #composition: ConversationSessionComposition;

  constructor(
    id: string,
    options: {
      startedAt: string;
      composition: ConversationSessionComposition;
    },
  ) {
    this.id = id;
    this.startedAt = options.startedAt;
    this.#composition = options.composition;
  }

  abort(): void {
    this.#composition.turnCoordinator.abort();
  }

  async *run(
    input: string | UserTurn,
    {
      skipUserMessage = false,
      retries = {},
      maxModelRetries,
      signal,
      resumeState,
    }: {
      skipUserMessage?: boolean;
      retries?: Record<string, number>;
      maxModelRetries?: number;
      signal?: AbortSignal;
      resumeState?: RunState<any, any>;
    } = {},
  ): AsyncIterable<ConversationEvent> {
    yield* this.#composition.turnCoordinator.start(input, {
      skipUserMessage,
      retries,
      maxModelRetries,
      signal,
      resumeState,
    });
  }

  /**
   * Continue a session after an approval decision.
   * Delegates to the TurnCoordinator.
   */
  async *continueAfterApproval({
    answer,
    rejectionReason,
  }: {
    answer: string;
    rejectionReason?: string;
  }): AsyncIterable<ConversationEvent> {
    yield* this.#composition.turnCoordinator.continueAfterApproval({
      answer,
      rejectionReason,
    });
  }
}
