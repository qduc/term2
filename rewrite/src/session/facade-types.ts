/** Direct host boundary. These domain contracts do not invoke the bridge Session.
 * Admission is not completion; capture is an atomic snapshot/subscription cut.
 * M3/M4 extend this facade when their actual domain capabilities land.
 */
import type { InteractionDecision, InteractionRequest, InteractionRequestId, TurnId } from '../engine/index.js';
import type { ContentPart, ModelRef, Usage } from '../model/index.js';
import type { ExecutionId, Workspace } from '../tools/index.js';
import type { AnswerResult } from './direct-types.js';
import type { Fact } from './facts.js';

export type DirectOrigin = { readonly kind: 'cli' | 'tui' | 'acp' | 'control' | 'discord' | 'api'; readonly id?: string };
export type DirectBinding = { readonly client: string; readonly id: string };
export type DirectSubmission = {
  readonly clientRequestId: string;
  readonly content: readonly ContentPart[];
  readonly origin?: DirectOrigin;
};
export type DirectAdmission =
  | { readonly kind: 'started' | 'queued' | 'steering'; readonly clientRequestId: string; readonly messageId: string; readonly turnId?: TurnId }
  | { readonly kind: 'duplicate'; readonly clientRequestId: string; readonly original: Exclude<DirectAdmission, { readonly kind: 'duplicate' }> }
  | { readonly kind: 'rejected'; readonly clientRequestId: string; readonly reason: string };
export type DirectMessage = { readonly id: string; readonly role: 'user' | 'assistant'; readonly content: readonly ContentPart[] };
export type DirectToolDisplay = {
  readonly executionId: ExecutionId;
  readonly turnId: TurnId;
  readonly toolName: string;
  readonly input: unknown;
  readonly status: 'started' | 'completed' | 'unknown';
  readonly output?: string;
};
export type DirectSessionState = {
  readonly id: string;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  readonly status: 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';
  readonly messages: readonly DirectMessage[];
  readonly tools: readonly DirectToolDisplay[];
  readonly pendingInteractions: readonly InteractionRequest[];
  readonly admissions: readonly DirectAdmission[];
  readonly usage: Usage;
};
/** Position is a private live publication ordinal, never a durable fact sequence. */
export type DirectSessionUpdate =
  | { readonly type: 'fact'; readonly position: number; readonly seq: number; readonly fact: Fact }
  | { readonly type: 'transient'; readonly position: number; readonly event: { readonly type: 'reasoning_delta'; readonly delta: string } | { readonly type: 'tool_progress'; readonly executionId: ExecutionId; readonly chunk: string } }
  | { readonly type: 'state'; readonly position: number; readonly state: DirectSessionState };
export type DirectSessionCapture = { readonly state: DirectSessionState; readonly position: number; unsubscribe(): void };
export type DirectCancelTarget = { readonly kind: 'foreground' } | { readonly kind: 'task'; readonly id: string };
export interface DirectSession {
  readonly id: string;
  submit(request: DirectSubmission): Promise<DirectAdmission>;
  answer(requestId: InteractionRequestId, decision: InteractionDecision): AnswerResult;
  /** Cancels the selected run, not this Session/connection; cleanup retains admission ownership. */
  cancel(target?: DirectCancelTarget): void;
  /** Listener receives updates strictly after the returned position, in publication order. */
  capture(listener: (update: DirectSessionUpdate) => void): DirectSessionCapture;
  /** Releases the owned runtime/store handle, not a persisted domain-close operation. */
  close(): Promise<void>;
}
export interface DirectSessionStore {
  create(workspace: Workspace, model: ModelRef, binding?: DirectBinding): Promise<DirectSession>;
  /** Read/replay only; one writable live Session per id per host; never restarts tools. */
  open(id: string, binding?: DirectBinding): Promise<DirectSession>;
  list(cursor?: string): Promise<{ readonly sessions: readonly { readonly id: string; readonly workspace: Workspace; readonly model: ModelRef }[]; readonly cursor?: string }>;
  close(): Promise<void>;
}
