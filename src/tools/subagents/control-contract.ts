import type { ContinuationHandle } from '../../shared/contracts/continuation-handle.js';

export interface BackgroundSubagentApprovalSnapshot {
  runId: string;
  generation: number;
  interruption: unknown;
}

/** Exact continuation exposed to session approval policy, not directly resumed. */
export interface BackgroundSubagentApprovalApplication {
  readonly runId: string;
  readonly generation: number;
  readonly handle: ContinuationHandle;
  readonly interruption: unknown;
}

/** Atomically apply a decision to this pause; false means it is stale. */
export interface BackgroundSubagentApprovalPause extends BackgroundSubagentApprovalSnapshot {
  readonly role: string;
  apply(callback: (application: BackgroundSubagentApprovalApplication) => boolean): boolean;
}

export type ForegroundSubagentApprovalPause = BackgroundSubagentApprovalPause;
export type ForegroundSubagentApprovalCallback = (pause: ForegroundSubagentApprovalPause) => void | Promise<void>;
export type BackgroundSubagentApprovalPauseSink = (pause: BackgroundSubagentApprovalPause) => void;

/** Read-only control projection; the host retains the execution lease. */
export interface ForegroundSubagentCandidate {
  runId: string;
  role: string;
  task: string;
  parentTool?: string;
  startedAt: number;
  model?: { provider: string; id: string };
}
