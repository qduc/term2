/** Direct Session boundary; no engine acceptance tokens reach callers. */
import type { InteractionDecision, InteractionRequestId, TurnDeps, TurnEvent, TurnSpec } from '../engine/index.js';
import type { DirectContextFactory } from './capabilities.js';
import type { DirectContextState } from './context.js';
import type { DirectBackgroundTasks } from './background.js';
import type {
  DirectQueueState,
  DirectQueueSubmission,
  DirectQueueCommand,
  DirectQueueMutation,
} from './queue-types.js';
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
    decision: import('../engine/types.js').BudgetDecision,
    provenance?: AnswerProvenance,
  ): AnswerResult;
  answer(requestId: InteractionRequestId, decision: InteractionDecision, provenance?: AnswerProvenance): AnswerResult;
};
export type TurnRequest = Omit<TurnSpec, 'turnId' | 'history' | 'newItems'> & {
  readonly input: TurnSpec['newItems'];
  readonly notice?: string;
  /** Actual source profile mode label, supplied by app from resolved profile metadata. */
  readonly previewMode?: string;
  /** Optional durable facade correlation; committed atomically with turn_started. */
  readonly submission?: SubmissionMetadata;
};
export type StartedConversationTurn = { readonly turnId: import('../engine/index.js').TurnId; readonly turn: Turn };
export type Conversation = {
  readonly id: string;
  run(request: TurnRequest): Turn;
  /** Reserves mutation before awaiting the host's physical/completion barrier. */
  command(
    request: import('./command-types.js').DirectCommandRequest,
    settings: Omit<TurnRequest, 'input' | 'submission'>,
    settleForeground: () => Promise<void>,
  ): Promise<{
    readonly result: import('./command-types.js').DirectCommandResult;
    readonly started?: StartedConversationTurn;
  }>;
  /** Installed future-root settings; fallback is used before the first configure. */
  currentRequest(fallback: Omit<TurnRequest, 'input' | 'submission'>): Omit<TurnRequest, 'input' | 'submission'>;
  cancelCommand(): void;
  drainBackgroundNotifications(
    clientRequestId: string,
    settings: Omit<TurnRequest, 'input' | 'submission'>,
  ): {
    readonly result: import('./notifications.js').DirectNotificationDrainResult;
    readonly started?: StartedConversationTurn;
  };
  configureTaskCheckIn(
    target: string,
    policy: import('./background-check-ins.js').DirectBackgroundCheckInPolicy,
  ): ReturnType<import('./background-check-ins.js').DirectBackgroundCheckIns['configure']>;
  /** Current accepted root-history/configuration revision; no mutation or receipt allocation. */
  commandRevision(): string;
  rewindTargets(): readonly import('./command-types.js').DirectRewindTarget[];
  submit(
    request: DirectQueueSubmission,
    settings: Omit<TurnRequest, 'input' | 'submission'>,
    expectedSteerTurnId?: import('../engine/index.js').TurnId,
  ): { readonly admission: DirectAdmission; readonly started?: StartedConversationTurn };
  queue(command: DirectQueueCommand): DirectQueueMutation;
  advanceQueue(settings?: Omit<TurnRequest, 'input' | 'submission'>): StartedConversationTurn | undefined;
  answer(requestId: InteractionRequestId, decision: InteractionDecision, provenance?: AnswerProvenance): AnswerResult;
  answerBudget(
    requestId: InteractionRequestId,
    decision: import('../engine/types.js').BudgetDecision,
    provenance?: AnswerProvenance,
  ): AnswerResult;
  readonly tasks: DirectBackgroundTasks;
  /** Pure planned provider input; never accepts draft/context or advances continuity. */
  snapshotInputPreview(request: TurnRequest): import('./preview.js').DirectPlannedInput;
  /** Accepted provider history as of now, without inventing crash-time repairs. */
  acceptedHistory(): readonly import('../model/index.js').Item[];
  abort(
    expectedTurnId: import('../engine/index.js').TurnId,
    discardQueue?: boolean,
    returnSteers?: boolean,
  ): import('./facade-types.js').DirectAbortResult;
  /** Actual accepted request for this completed root, consumed before foreground queue dispatch. */
  rolloverAtBoundary(
    turnId: import('../engine/index.js').TurnId,
  ): import('./command-types.js').DirectCommandRequest | undefined;
  context(): DirectContextState;
  setGoal(
    expectedGeneration: number,
    goal: import('./goal.js').DurableGoal | undefined,
    source?: 'user' | 'launcher',
  ): boolean;
  /** Cancels/drains any live turn before releasing the log writer. */
  close(): Promise<void>;
};
export type ConversationDeps = TurnDeps & {
  readonly log: ConversationLog;
  readonly context?: DirectContextFactory;
  /** Prepare without installation/publication; Session drains and owns acceptance. */
  readonly configure?: (
    configuration: import('./command-types.js').DirectCommandConfiguration,
    signal: AbortSignal,
  ) => Promise<import('./configuration.js').DirectPreparedConfiguration>;
  /** Prepare only under the command reservation; native owns rotation and admission. */
  readonly rollover?: import('./session-rotation.js').DirectRolloverPreparer;
  /** Store-owned physical boundary, never supplied by app as write authority. */
  readonly rotationBoundary?: () => import('./rolling-log.js').DirectLogBoundary;
  readonly authorizeNested?: import('./branches.js').DirectNestedAuthorizer;
  /** Store-owned live publishers: they forward transients to the session's subscribers, never to the log. */
  readonly publishNotice?: (notice: import('./memory.js').DirectAutomaticMemoryNotice) => void;
  readonly publishBranch?: (event: import('./facade-types.js').DirectBranchTransient) => void;
  readonly publishTask?: (event: import('./background-types.js').DirectBackgroundProgress) => void;
};
export type ReplayedConversation = {
  readonly status: 'idle' | 'interrupted';
  readonly history: readonly import('../model/index.js').Item[];
  readonly nextTurn: number;
  readonly queue: DirectQueueState;
  readonly compactionState?: {
    readonly rearmAtEstimatedTokens?: number;
    readonly rearmAtRenderedTokens?: number;
    readonly checkpointReceipts?: readonly string[];
  };
  /** Ordered missing tool results, interaction closures, then interrupted terminal. Empty after materialization. */
  readonly recoveryFacts: readonly Fact[];
};
