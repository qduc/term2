/**
 * The durable vocabulary of a conversation log. Native facts, not source
 * LogEvents; nothing here goes through `SessionFact`, the reducer or the store.
 *
 * The profile notice is deliberately not a fact: `input` is the user's own
 * input, and history replays exactly that.
 */

import type {
  TurnId,
  ExecutionId,
  InteractionDecision,
  InteractionRequest,
  InteractionRequestId,
} from '../engine/index.js';
import type { DirectBackgroundFact } from './direct-background-types.js';
import type { DirectQueueFact } from './direct-queue-types.js';
import type { DirectContextFact } from './direct-context.js';
import type { DirectNotificationFact } from './direct-notifications.js';
import type { DirectCommandFact } from './direct-command-types.js';
import type { BudgetDecision } from '../engine/direct-types.js';
import type { ModelRequestCost, RunBudgetEvent, RunBudgetSnapshot } from '../engine/direct-recovery-budget.js';
import type { StopReason } from '../model/index.js';
import type { ToolResult } from '../tools/index.js';
import type { DirectBinding, DirectOrigin } from './facade-types.js';
import type { Item, ModelError, ModelRef, ReasoningEffort, Usage } from '../model/index.js';

export const LOG_FORMAT_VERSION = 1;

export type SessionStartedFact = {
  readonly type: 'session_started';
  readonly id: string;
  readonly workspace: string;
  /** Full authorized identity; legacy direct path-only records require a current local grant. */
  readonly workspaceIdentity?: import('../tools/index.js').Workspace;
  readonly forkedFrom?: string;
  /** Source direct Session, retained on a newly created rollover successor. */
  readonly rolloverFrom?: string;
  readonly model: ModelRef;
  readonly reasoning?: ReasoningEffort;
  readonly profile: { readonly id: string; readonly version: string; readonly digest: string };
  readonly appVersion: string;
  /** Immutable client binding, validated by the store before writable open. */
  readonly binding?: DirectBinding;
};

/** Submission correlation is in the same durable line as turn admission. */
export type SubmissionMetadata = {
  readonly clientRequestId: string;
  /** ID of the submitted user item in turn_started.input. */
  readonly messageId: string;
  readonly origin?: DirectOrigin;
};

export type TurnOutcomeName = 'completed' | 'cancelled' | 'failed' | 'interrupted';

export type DirectTurnFact =
  | {
      readonly type: 'budget_opened';
      readonly requestId: InteractionRequestId;
      readonly turnId: TurnId;
      readonly evidence: RunBudgetEvent;
      readonly snapshot: RunBudgetSnapshot;
    }
  | {
      readonly type: 'budget_closed';
      readonly requestId: InteractionRequestId;
      readonly turnId: TurnId;
      readonly decision: BudgetDecision;
      readonly source: 'user' | 'parent' | 'system';
    }
  | { readonly type: 'budget_observed'; readonly turnId: TurnId; readonly evidence: RunBudgetEvent }
  | {
      readonly type: 'turn_started';
      /** Actual command-owned auxiliary invocation, not a human or background-notice admission. */
      readonly maintenance?: { readonly kind: 'compaction'; readonly commandId: string };
      readonly requestConfiguration?: import('./direct-preview.js').DirectPreviewConfiguration;
      /** Native background planning input is durable provider context, never a displayed human admission. */
      readonly silent?: true;
      /** A command continuation reuses retained human context; it is not a new admission. */
      readonly retryContext?: {
        readonly sourceTurnId: TurnId;
        readonly throughItemId: import('../model/index.js').ItemId;
      };
      readonly turnId: TurnId;
      readonly input: readonly Item[];
      readonly submission?: SubmissionMetadata;
    }
  /** Written but not fsynced. Replay turns unsuperseded deltas into an assistant message. */
  | { readonly type: 'text_delta'; readonly turnId: TurnId; readonly delta: string; readonly modelStep?: number }
  | {
      readonly type: 'item';
      readonly turnId: TurnId;
      readonly item: Item;
      readonly executionId?: ExecutionId;
      readonly modelStep?: number;
    }
  | {
      readonly type: 'tool_started';
      readonly turnId: TurnId;
      readonly executionId: ExecutionId;
      readonly parentExecutionId?: ExecutionId;
      readonly callId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_finished';
      readonly turnId: TurnId;
      readonly executionId: ExecutionId;
      readonly result: ToolResult;
    }
  | { readonly type: 'interaction_opened'; readonly turnId: TurnId; readonly request: InteractionRequest }
  | {
      readonly type: 'interaction_closed';
      readonly turnId: TurnId;
      readonly requestId: InteractionRequestId;
      readonly resolution: InteractionDecision | { readonly kind: 'cancelled' | 'interrupted' };
      readonly resolutionSource?: 'user' | 'policy' | 'system';
      readonly automaticApproval?: boolean;
    }
  | { readonly type: 'usage'; readonly turnId: TurnId; readonly usage: Usage; readonly modelStep?: number }
  | {
      readonly type: 'turn_ended';
      readonly turnId: TurnId;
      /** Accepted root public evidence; absent on old/recovered or nested terminals. */
      readonly finalWindow?: import('./direct-final.js').DirectFinalWindow;
      readonly outcome: TurnOutcomeName;
      readonly error?: ModelError;
      readonly terminalCause?: 'goal_check_unresolved' | 'completion_verification_blocked' | 'budget_exhausted';
      readonly notice?: string;
    }
  | {
      readonly type: 'model_response_completed';
      readonly turnId: TurnId;
      readonly modelStep: number;
      readonly stopReason: StopReason;
      readonly continuation?: unknown;
      readonly providerMetadata?: Readonly<Record<string, unknown>>;
      readonly costUsd?: number | string;
    };

/** One JSONL line. */
export type FactLine = {
  readonly v: typeof LOG_FORMAT_VERSION;
  readonly seq: number;
  readonly at: string;
  readonly fact: Fact;
};

/** Provider transcript edits do not retract physical execution audit facts. */
export type DirectHistoryFact = {
  readonly type: 'history_replaced';
  readonly turnId?: TurnId;
  readonly reason: 'compaction' | 'retry_turn' | 'retry_tool' | 'rewind';
  readonly history: readonly Item[];
  readonly rearmAtEstimatedTokens?: number;
  readonly checkpointReceipts?: readonly string[];
};

/** Physical accounting is independent of transcript edits and includes nested/summary/failed requests. */
export type DirectRequestCostFact = {
  readonly type: 'request_cost_recorded';
  readonly turnId: TurnId;
  readonly rootTurnId: TurnId;
  readonly parentTurnId?: TurnId;
  readonly record: ModelRequestCost;
};

/** Child audit is isolated from the foreground transcript, but uses the same writer. */
export type DirectBranchFact =
  | {
      readonly type: 'branch_started';
      readonly parentTurnId?: TurnId;
      readonly rootTurnId?: TurnId;
      readonly branchId: string;
      readonly taskId: string;
      readonly turnId: TurnId;
      readonly input: readonly Item[];
    }
  | {
      readonly type: 'branch_event';
      readonly branchId: string;
      readonly fact:
        | Exclude<DirectTurnFact, { readonly type: 'turn_started' | 'interaction_opened' | 'interaction_closed' }>
        | (DirectHistoryFact & { readonly turnId: TurnId });
    };

export type Fact =
  | SessionStartedFact
  | DirectTurnFact
  | DirectHistoryFact
  | DirectBranchFact
  | DirectRequestCostFact
  | DirectCommandFact
  | import('./direct-configuration.js').DirectConfigurationFact
  | DirectNotificationFact
  | DirectQueueFact
  | DirectBackgroundFact
  | DirectContextFact;

/** Narrow native vocabulary without interpreting authority or restoring live work. */
export function isDirectTaskFact(fact: Fact): fact is DirectBackgroundFact {
  return fact.type.startsWith('task_');
}
export function isDirectQueueFact(fact: Fact): fact is DirectQueueFact {
  return fact.type.startsWith('queue_');
}
