/** Direct host boundary. These domain contracts do not invoke the bridge Session.
 * Admission is not completion; capture is an atomic snapshot/subscription cut.
 * M3/M4 extend this facade when their actual domain capabilities land.
 */
import type { InteractionDecision, InteractionRequest, InteractionRequestId, TurnId } from '../engine/index.js';
import type { ContentPart, ModelError, ModelRef, Usage } from '../model/index.js';
import type { ExecutionId, Workspace } from '../tools/index.js';
import type { DirectContextState } from './direct-context.js';
import type { DirectTaskState, DirectBackgroundProgress } from './direct-background-types.js';
import type {
  DirectQueueState,
  DirectQueueEdit,
  DirectQueueMutation,
  DirectQueueSubmission,
} from './direct-queue-types.js';
import type { AnswerResult, AnswerProvenance } from './direct-types.js';
import type { Fact, TurnOutcomeName } from './facts.js';

export type DirectOrigin =
  | {
      readonly kind: 'discord';
      readonly source: 'human' | 'agent' | 'reaction';
      readonly sender: string;
      readonly discordMessageId?: string;
      readonly relayedBy?: string;
    }
  | { readonly kind: 'control'; readonly source?: 'orchestrator'; readonly id?: string }
  | { readonly kind: 'cli' | 'tui' | 'acp' | 'api'; readonly id?: string };
export type DirectBinding = { readonly client: string; readonly id: string };
export type DirectSubmission = {
  readonly clientRequestId: string;
  readonly content: readonly ContentPart[];
  readonly origin?: DirectOrigin;
};
export type DirectAdmission =
  | {
      readonly kind: 'started' | 'queued' | 'steering';
      readonly clientRequestId: string;
      readonly messageId: string;
      readonly turnId?: TurnId;
    }
  | {
      readonly kind: 'duplicate';
      readonly clientRequestId: string;
      readonly original: Exclude<DirectAdmission, { readonly kind: 'duplicate' }>;
    }
  | { readonly kind: 'rejected'; readonly clientRequestId: string; readonly reason: string };
export type DirectMessage = {
  readonly id: string;
  readonly turnId?: TurnId;
  readonly role: 'user' | 'assistant';
  readonly content: readonly ContentPart[];
};
export type DirectToolDisplay = {
  readonly executionId: ExecutionId;
  readonly turnId: TurnId;
  readonly callId: string;
  readonly parentExecutionId?: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly status: 'started' | 'completed' | 'unknown';
  readonly output?: string;
  readonly isError?: boolean;
  readonly providerOutput?: readonly Readonly<Record<string, unknown>>[];
  readonly display?: unknown;
};
export type DirectTimelineEntry = {
  readonly seq: number;
  readonly kind: 'message' | 'tool' | 'reasoning' | 'task';
  readonly id: string;
  readonly turnId?: TurnId;
  readonly modelStep?: number;
};
export type DirectAbortResult =
  | { readonly kind: 'aborted'; readonly turnId: TurnId; readonly discardedMessageIds: readonly string[] }
  | { readonly kind: 'no_op' | 'not_admitting'; readonly reason?: string };
export type DirectDraft = {
  readonly id: string;
  readonly turnId: TurnId;
  readonly modelStep: number;
  readonly text: string;
};
export type DirectSessionState = {
  readonly id: string;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  readonly status: 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';
  readonly activeTurnId: TurnId | null;
  readonly drafts: readonly DirectDraft[];
  readonly reasoning: string;
  readonly terminal: {
    readonly turnId: TurnId;
    readonly outcome: TurnOutcomeName;
    readonly error?: ModelError;
    readonly terminalCause?: 'goal_check_unresolved' | 'completion_verification_blocked' | 'budget_exhausted';
    readonly notice?: string;
  } | null;
  readonly messages: readonly DirectMessage[];
  readonly tools: readonly DirectToolDisplay[];
  readonly pendingInteractions: readonly InteractionRequest[];
  readonly admissions: readonly DirectAdmission[];
  readonly usage: Usage;
  readonly requestCosts: readonly import('./facts.js').DirectRequestCostFact[];
  readonly pendingBudgets: readonly Extract<Fact, { readonly type: 'budget_opened' }>[];
  readonly timeline: readonly DirectTimelineEntry[];
  readonly context: DirectContextState;
  readonly tasks: readonly DirectTaskState[];
  readonly queue: DirectQueueState;
  readonly turnResults: readonly {
    readonly turnId: TurnId;
    readonly outcome: TurnOutcomeName;
    readonly messages: readonly DirectMessage[];
    readonly terminalCause?: string;
    readonly notice?: string;
  }[];
};
/** Position is a private live publication ordinal, never a durable fact sequence. */
export type DirectSessionUpdate =
  | { readonly type: 'fact'; readonly position: number; readonly seq: number; readonly at: string; readonly fact: Fact }
  | {
      readonly type: 'transient';
      readonly position: number;
      readonly event:
        | {
            readonly type: 'automatic_memory_notice';
            readonly notice: import('./direct-memory.js').DirectAutomaticMemoryNotice;
          }
        | DirectBackgroundProgress
        | { readonly type: 'reasoning_delta'; readonly delta: string }
        | { readonly type: 'tool_progress'; readonly executionId: ExecutionId; readonly chunk: string };
    }
  | { readonly type: 'state'; readonly position: number; readonly state: DirectSessionState };
export type DirectSessionCapture = {
  readonly state: DirectSessionState;
  readonly position: number;
  readonly seq: number;
  unsubscribe(): void;
};
/** Reconnect applies replay only, not current state followed by old facts. */
export type DirectSessionReplayCapture = DirectSessionCapture & {
  readonly replay: readonly Extract<DirectSessionUpdate, { readonly type: 'fact' }>[];
};
export type DirectCancelTarget = { readonly kind: 'foreground' } | { readonly kind: 'task'; readonly id: string };
export interface DirectSession {
  readonly id: string;
  snapshotInputPreview(
    request: import('./direct-preview.js').DirectPreviewRequest,
  ): import('./direct-preview.js').DirectPreviewSnapshot;
  submit(request: DirectSubmission): Promise<DirectAdmission>;
  submitWithDelivery(request: DirectQueueSubmission): Promise<DirectAdmission>;
  editQueue(messageId: string, edit: DirectQueueEdit): Promise<DirectQueueMutation>;
  retractQueue(messageId: string): Promise<DirectQueueMutation>;
  resumeQueue(): Promise<DirectQueueMutation>;
  discardQueue(): Promise<DirectQueueMutation>;
  abort(expectedTurnId: TurnId, discardQueue?: boolean): DirectAbortResult;
  answerBudget(
    requestId: InteractionRequestId,
    decision: import('../engine/direct-types.js').BudgetDecision,
    provenance?: AnswerProvenance,
  ): AnswerResult;
  setGoal(
    expectedGeneration: number,
    goal: import('./direct-goal.js').DurableGoal | undefined,
    source?: 'user' | 'launcher',
  ): boolean;
  answer(requestId: InteractionRequestId, decision: InteractionDecision, provenance?: AnswerProvenance): AnswerResult;
  /** Cancels the selected run, not this Session/connection; cleanup retains admission ownership. */
  cancel(target?: DirectCancelTarget): void;
  /** Listener receives updates strictly after the returned position, in publication order. */
  capture(listener: (update: DirectSessionUpdate) => void): DirectSessionCapture;
  /** Atomic accepted facts (fromSeq, seq], then listener strictly after position. */
  captureFrom(fromSeq: number, listener: (update: DirectSessionUpdate) => void): DirectSessionReplayCapture;
  /** Releases the owned runtime/store handle, not a persisted domain-close operation. */
  close(): Promise<void>;
}
export interface DirectSessionStore {
  create(workspace: Workspace, model: ModelRef, binding?: DirectBinding): Promise<DirectSession>;
  /** Read/replay only; one writable live Session per id per host; never restarts tools. */
  open(id: string, binding?: DirectBinding): Promise<DirectSession>;
  list(cursor?: string): Promise<{
    readonly sessions: readonly { readonly id: string; readonly workspace: Workspace; readonly model: ModelRef }[];
    readonly cursor?: string;
  }>;
  close(): Promise<void>;
}
