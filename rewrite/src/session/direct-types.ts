/** Direct Session boundary; no engine acceptance tokens reach callers. */
import type { InteractionDecision, InteractionRequestId, TurnDeps, TurnEvent, TurnSpec } from '../engine/index.js';
import type { DirectContextFactory } from './direct-capabilities.js';
import type { DirectContextState } from './direct-context.js';
import type { DirectBackgroundTasks } from './direct-background.js';
import type {
  DirectQueueState,
  DirectQueueSubmission,
  DirectQueueCommand,
  DirectQueueMutation,
} from './direct-queue-types.js';
import type { DirectAdmission } from './facade-types.js';
import type { ModelError } from '../model/index.js';
import type { Fact, SubmissionMetadata } from './facts.js';
import type { ConversationLog } from './log.js';

export type AnswerResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: ModelError };
export type AnswerProvenance = { readonly source: 'user' | 'policy' | 'system'; readonly automaticApproval?: boolean };
export type Turn = {
  readonly events: AsyncIterable<TurnEvent>;
  cancel(): void;
  answerBudget(
    requestId: InteractionRequestId,
    decision: import('../engine/direct-types.js').BudgetDecision,
    provenance?: AnswerProvenance,
  ): AnswerResult;
  answer(requestId: InteractionRequestId, decision: InteractionDecision, provenance?: AnswerProvenance): AnswerResult;
};
export type TurnRequest = Omit<TurnSpec, 'turnId' | 'history' | 'newItems'> & {
  readonly input: TurnSpec['newItems'];
  readonly notice?: string;
  /** Optional durable facade correlation; committed atomically with turn_started. */
  readonly submission?: SubmissionMetadata;
};
export type StartedConversationTurn = { readonly turnId: import('../engine/index.js').TurnId; readonly turn: Turn };
export type Conversation = {
  readonly id: string;
  run(request: TurnRequest): Turn;
  submit(
    request: DirectQueueSubmission,
    settings: Omit<TurnRequest, 'input' | 'submission'>,
  ): { readonly admission: DirectAdmission; readonly started?: StartedConversationTurn };
  queue(command: DirectQueueCommand): DirectQueueMutation;
  advanceQueue(settings?: Omit<TurnRequest, 'input' | 'submission'>): StartedConversationTurn | undefined;
  answer(requestId: InteractionRequestId, decision: InteractionDecision, provenance?: AnswerProvenance): AnswerResult;
  answerBudget(
    requestId: InteractionRequestId,
    decision: import('../engine/direct-types.js').BudgetDecision,
    provenance?: AnswerProvenance,
  ): AnswerResult;
  readonly tasks: DirectBackgroundTasks;
  abort(
    expectedTurnId: import('../engine/index.js').TurnId,
    discardQueue?: boolean,
  ): import('./facade-types.js').DirectAbortResult;
  context(): DirectContextState;
  setGoal(
    expectedGeneration: number,
    goal: import('./direct-goal.js').DurableGoal | undefined,
    source?: 'user' | 'launcher',
  ): boolean;
  /** Cancels/drains any live turn before releasing the log writer. */
  close(): Promise<void>;
};
export type ConversationDeps = TurnDeps & {
  readonly log: ConversationLog;
  readonly context?: DirectContextFactory;
  readonly authorizeNested?: import('./direct-branches.js').DirectNestedAuthorizer;
  readonly publishNotice?: (notice: import('./direct-memory.js').DirectAutomaticMemoryNotice) => void;
  readonly publishTask?: (event: import('./direct-background-types.js').DirectBackgroundProgress) => void;
};
export type ReplayedConversation = {
  readonly status: 'idle' | 'interrupted';
  readonly history: readonly import('../model/index.js').Item[];
  readonly nextTurn: number;
  readonly queue: DirectQueueState;
  readonly compactionState?: {
    readonly rearmAtEstimatedTokens?: number;
    readonly checkpointReceipts?: readonly string[];
  };
  /** Ordered missing tool results, interaction closures, then interrupted terminal. Empty after materialization. */
  readonly recoveryFacts: readonly Fact[];
};
