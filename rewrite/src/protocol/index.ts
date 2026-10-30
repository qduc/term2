/**
 * protocol/ — the one public wire format.
 *
 * Every client, local or remote, sees sessions only through these types.
 * `toWire` is the single projection from session updates to public events:
 * it bounds sizes and strips private fields (paths, credentials, opaque
 * provider state). Adding an engine event means touching this file once.
 * Depends on: session (and the types it re-exports).
 */

import type { SessionState, SessionStatus, SessionUpdate } from '../session/index.js';

export const PROTOCOL_VERSION = 1;

export type WireEventType =
  | 'turn_started'
  | 'text_delta'
  | 'reasoning_delta'
  | 'message'
  | 'tool_started'
  | 'tool_progress'
  | 'tool_finished'
  | 'interaction_opened'
  | 'interaction_resolved'
  | 'usage'
  | 'retrying'
  | 'compacted'
  | 'subagent'
  | 'status_changed'
  | 'turn_ended';

export type WireEvent = {
  readonly sessionId: string;
  /** Log sequence for persisted facts; null for live-only events such as deltas. */
  readonly seq: number | null;
  readonly turnId: string | null;
  readonly type: WireEventType;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type WireMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly toolName?: string;
  readonly isError?: boolean;
};

export type WireInteraction = {
  readonly interactionId: string;
  readonly approvals: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly summary: string;
    readonly risk: 'low' | 'medium' | 'high';
    readonly agentId?: string;
  }[];
};

/** What a client needs to render a session from scratch before streaming events. */
export type WireSnapshot = {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly model: { readonly provider: string; readonly model: string };
  readonly messages: readonly WireMessage[];
  readonly pendingInteraction: WireInteraction | null;
  readonly canRetry: boolean;
  readonly seq: number;
};

export type WireCommand =
  | {
      readonly type: 'submit';
      readonly requestId: string;
      readonly text: string;
      readonly attachments?: readonly unknown[];
    }
  | {
      readonly type: 'decide';
      readonly interactionId: string;
      readonly decisions: readonly { readonly callId: string; readonly approve: boolean; readonly reason?: string }[];
    }
  | { readonly type: 'cancel' }
  | { readonly type: 'retry' }
  | { readonly type: 'compact' }
  | { readonly type: 'set_model'; readonly provider: string; readonly model: string };

export type WireCommandResult =
  | { readonly ok: true; readonly turnId?: string; readonly queuedPosition?: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface Projection {
  /** Returns null for updates clients never see. */
  toWire(sessionId: string, update: SessionUpdate): WireEvent | null;
  snapshot(sessionId: string, state: SessionState): WireSnapshot;
}
