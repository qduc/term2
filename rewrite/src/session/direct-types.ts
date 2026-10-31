/** Direct Session boundary; no engine acceptance tokens reach callers. */
import type { InteractionDecision, InteractionRequestId, TurnDeps, TurnEvent, TurnSpec } from '../engine/index.js';
import type { ModelError } from '../model/index.js';
import type { Fact, SubmissionMetadata } from './facts.js';
import type { ConversationLog } from './log.js';

export type AnswerResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: ModelError };
export type Turn = {
  readonly events: AsyncIterable<TurnEvent>;
  cancel(): void;
  answer(requestId: InteractionRequestId, decision: InteractionDecision): AnswerResult;
};
export type TurnRequest = Omit<TurnSpec, 'turnId' | 'history' | 'newItems'> & {
  readonly input: TurnSpec['newItems'];
  readonly notice?: string;
  /** Optional durable facade correlation; committed atomically with turn_started. */
  readonly submission?: SubmissionMetadata;
};
export type Conversation = {
  readonly id: string;
  run(request: TurnRequest): Turn;
  /** Cancels/drains any live turn before releasing the log writer. */
  close(): Promise<void>;
};
export type ConversationDeps = TurnDeps & { readonly log: ConversationLog };
export type ReplayedConversation = {
  readonly status: 'idle' | 'interrupted';
  readonly history: readonly import('../model/index.js').Item[];
  readonly nextTurn: number;
  /** Ordered missing tool results, interaction closures, then interrupted terminal. Empty after materialization. */
  readonly recoveryFacts: readonly Fact[];
};
