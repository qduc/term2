/** Fixture-only types for the pre-C2 native engine experiment. */
import type { Item, ModelRef } from '../../src/model/index.js';
import type { Workspace } from '../../src/tools/index.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  EngineEvent,
  TurnCheckpoint,
  TurnId,
  TurnRun,
} from '../../src/engine/index.js';

export type TracerSessionId = string & { readonly __brand: 'TracerSessionId' };
export type TracerClientRequestId = string & { readonly __brand: 'TracerClientRequestId' };
export type TracerInteractionId = string & { readonly __brand: 'TracerInteractionId' };
export type TracerFact =
  | { readonly type: 'session_created'; readonly workspace: Workspace; readonly model: ModelRef }
  | { readonly type: 'input_queued'; readonly requestId: TracerClientRequestId; readonly items: readonly Item[] }
  | { readonly type: 'turn_started'; readonly turnId: TurnId; readonly requestId: TracerClientRequestId | null }
  | { readonly type: 'item_committed'; readonly turnId: TurnId; readonly item: Item }
  | { readonly type: 'checkpoint_saved'; readonly checkpoint: TurnCheckpoint }
  | {
      readonly type: 'interaction_opened';
      readonly turnId: TurnId;
      readonly interactionId: TracerInteractionId;
      readonly approvals: readonly ApprovalRequest[];
    }
  | {
      readonly type: 'interaction_resolved';
      readonly interactionId: TracerInteractionId;
      readonly decisions: readonly {
        readonly callId: ApprovalRequest['callId'];
        readonly decision: ApprovalDecision;
      }[];
    }
  | {
      readonly type: 'turn_ended';
      readonly turnId: TurnId;
      readonly outcome: 'completed' | 'cancelled' | 'failed' | 'budget_exhausted';
    }
  | { readonly type: 'turn_interrupted'; readonly turnId: TurnId; readonly reason: string }
  | { readonly type: 'history_compacted'; readonly history: readonly Item[] }
  | { readonly type: 'model_changed'; readonly model: ModelRef };
export type TracerLogEntry = { readonly seq: number; readonly at: string; readonly fact: TracerFact };
export interface TracerSessionLog {
  append(facts: readonly TracerFact[]): Promise<readonly number[]>;
  read(fromSeq?: number): AsyncIterable<TracerLogEntry>;
  readonly lastSeq: number;
}
export type TracerSessionStatus = 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';
export type TracerPendingInteraction = {
  readonly interactionId: TracerInteractionId;
  readonly turnId: TurnId;
  readonly approvals: readonly ApprovalRequest[];
};
export type TracerSessionState = {
  readonly id: TracerSessionId;
  readonly status: TracerSessionStatus;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  readonly history: readonly Item[];
  readonly activeTurnId: TurnId | null;
  readonly pendingInteraction: TracerPendingInteraction | null;
  readonly queue: readonly { readonly requestId: TracerClientRequestId; readonly items: readonly Item[] }[];
  readonly canRetry: boolean;
  readonly lastCheckpoint: TurnCheckpoint | null;
  readonly lastSeq: number;
};
export type TracerSessionUpdate =
  | { readonly kind: 'fact'; readonly entry: TracerLogEntry }
  | { readonly kind: 'live'; readonly turnId: TurnId; readonly event: EngineEvent };
export type TracerAdmission =
  | { readonly kind: 'started'; readonly turnId: TurnId }
  | { readonly kind: 'queued'; readonly position: number }
  | { readonly kind: 'duplicate'; readonly turnId: TurnId | null }
  | { readonly kind: 'rejected'; readonly reason: 'queue_full' | 'closed' };
export interface TracerSession {
  readonly id: TracerSessionId;
  state(): TracerSessionState;
  submit(requestId: TracerClientRequestId, items: readonly Item[]): Promise<TracerAdmission>;
  decide(
    interactionId: TracerInteractionId,
    decisions: readonly { readonly callId: ApprovalRequest['callId']; readonly decision: ApprovalDecision }[],
  ): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<TracerAdmission>;
  compact(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  subscribe(fromSeq: number, listener: (update: TracerSessionUpdate) => void): () => void;
  close(): Promise<void>;
}
export interface TracerStore {
  create(workspace: Workspace, model: ModelRef): Promise<TracerSession>;
  open(id: TracerSessionId): Promise<TracerSession>;
}
export type TracerSessionSummary = Pick<TracerSessionState, 'id' | 'status' | 'workspace' | 'lastSeq'> & {
  readonly title: string | null;
  readonly updatedAt: string;
};
export type TracerProject = (state: TracerSessionState, entry: TracerLogEntry) => TracerSessionState;
