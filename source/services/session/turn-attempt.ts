import type { AgentInputItem } from '@openai/agents';
import type { AgentStream } from '../agent-stream.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { AssistantJournalItemLogEvent } from '../logging/conversation-log-events.js';
import type { SessionInputPlan } from './session-input-planner.js';
import type { GenerationToken } from '../generation-guard.js';

export class TurnAttempt {
  readonly #turn: UserTurn;
  readonly #token: GenerationToken;
  readonly #initialRetryCounts: RetryCounts;
  readonly #initialJournalSnapshot: AssistantJournalItemLogEvent[];
  readonly #maxTransientRetries: number;
  readonly #maxModelRetries?: number;

  #retryCounts: RetryCounts;
  #stream: AgentStream | null = null;
  #streamInput: string | AgentInputItem | AgentInputItem[] | undefined = undefined;
  #inputMode: 'delta' | 'full_history' | undefined = undefined;
  #addedUserMessage = false;
  #closed = false;

  #signal?: AbortSignal;
  #abortListener?: () => void;

  constructor(options: {
    turn: UserTurn;
    token: GenerationToken;
    initialRetryCounts: RetryCounts;
    initialJournalSnapshot: AssistantJournalItemLogEvent[];
    maxTransientRetries: number;
    maxModelRetries?: number;
    signal?: AbortSignal;
    onAbort?: () => void;
  }) {
    this.#turn = options.turn;
    this.#token = options.token;
    this.#initialRetryCounts = options.initialRetryCounts;
    this.#initialJournalSnapshot = options.initialJournalSnapshot;
    this.#maxTransientRetries = options.maxTransientRetries;
    this.#maxModelRetries = options.maxModelRetries;
    this.#retryCounts = { ...options.initialRetryCounts };
    this.#signal = options.signal;

    if (this.#signal) {
      if (this.#signal.aborted) {
        if (options.onAbort) {
          options.onAbort();
        }
        throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
      }
      if (options.onAbort) {
        this.#abortListener = () => {
          options.onAbort?.();
        };
        this.#signal.addEventListener('abort', this.#abortListener);
      }
    }
  }

  get turn(): UserTurn {
    return this.#turn;
  }

  get token(): GenerationToken {
    return this.#token;
  }

  get initialRetryCounts(): RetryCounts {
    return this.#initialRetryCounts;
  }

  get initialJournalSnapshot(): AssistantJournalItemLogEvent[] {
    return this.#initialJournalSnapshot;
  }

  get maxTransientRetries(): number {
    return this.#maxTransientRetries;
  }

  get maxModelRetries(): number | undefined {
    return this.#maxModelRetries;
  }

  get retryCounts(): RetryCounts {
    return this.#retryCounts;
  }

  get stream(): AgentStream | null {
    return this.#stream;
  }

  get streamInput(): string | AgentInputItem | AgentInputItem[] | undefined {
    return this.#streamInput;
  }

  get inputMode(): 'delta' | 'full_history' | undefined {
    return this.#inputMode;
  }

  get addedUserMessage(): boolean {
    return this.#addedUserMessage;
  }

  get closed(): boolean {
    return this.#closed;
  }

  markUserMessageAdded(): void {
    this.#addedUserMessage = true;
  }

  attachInput(plan: SessionInputPlan): void {
    this.#streamInput = plan.streamInput;
    this.#inputMode = plan.inputSurgeKind;
  }

  attachStream(stream: AgentStream | null): void {
    this.#stream = stream;
  }

  advanceRetry(nextCounts: RetryCounts): void {
    this.#retryCounts = { ...nextCounts };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#signal && this.#abortListener) {
      this.#signal.removeEventListener('abort', this.#abortListener);
      this.#abortListener = undefined;
    }
  }
}
