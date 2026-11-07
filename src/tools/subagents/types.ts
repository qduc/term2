import type { NormalizedUsage } from '../../shared/utils/ai/token-usage.js';
import type { BackgroundTaskObservation } from '../background-task-activity.js';
import type { ModelRequestCost } from '../../shared/cost/model-cost.js';
import type { RunTerminationCause } from '../../shared/contracts/run-termination.js';

export const SUBAGENT_ROLES = ['explorer', 'worker', 'mentor', 'librarian', 'reviewer'] as const;
export type SupportedSubagentRole = (typeof SUBAGENT_ROLES)[number];
export type Phase1AsyncSubagentRole = 'explorer' | 'mentor';
export type SubagentRole = SupportedSubagentRole | string;

/** Narrow per-segment callbacks supplied by the logical async-run owner. */
export interface SubagentSegmentControl {
  onToolStart(): void;
  onToolComplete(): void;
  /** Suspend only the current async execution tool until the orchestrator replies. */
  askOrchestrator(question: string): Promise<string>;
}

export type SubagentSteerErrorCode =
  | 'invalid_guidance'
  | 'not_active'
  | 'unsupported_control'
  | 'steer_limit_reached'
  | 'question_mismatch'
  | 'question_not_pending'
  | 'question_pending';

export type SubagentSteerMailboxFullAcknowledgement = {
  ok: false;
  code: 'mailbox_full';
  target: string;
  limits: { messages: number; characters: number };
  occupancy: { messages: number; characters: number };
};

/** Immediate, non-blocking outcome of queueing a steering instruction. */
export type SubagentSteerAcknowledgement =
  | {
      ok: true;
      runId: string;
      status: 'running';
      delivery: 'queued' | 'answered';
    }
  | SubagentSteerMailboxFullAcknowledgement
  | {
      ok: false;
      code: SubagentSteerErrorCode;
      target: string;
    };

/** Immediate, non-blocking outcome of requesting cancellation by runId or active name. */
export type SubagentCancelAcknowledgement =
  | {
      ok: true;
      runId: string;
      status: 'cancelling';
    }
  | {
      ok: false;
      code: 'not_active';
      target: string;
    };

/** Per-file line-change evidence captured automatically from write tools. */
export interface DiffStatEntry {
  path: string;
  added: number;
  deleted: number;
}

/**
 * Validation command evidence captured automatically from the last
 * validation-shaped shell command the worker ran (test/lint/typecheck/build).
 * Makes verification independent of worker prose discipline.
 */
export interface ValidationEvidence {
  command: string;
  /** The shell's terminal exit code, or unknown when it did not terminate normally. */
  exitStatus: number | 'unknown';
  outputExcerpt: string;
}

export interface SubagentResult {
  agentId: string;
  /** Optional user-provided alias retained after an async run settles. */
  name?: string;
  role: string;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  finalText: string;
  /** Whether finalText is a bounded preview rather than the complete final response. */
  finalTextTruncated?: boolean;
  /** Temporary artifact containing the complete final response when finalText is truncated. */
  finalTextArtifactPath?: string;
  filesChanged: string[];
  toolsUsed: Array<{
    toolName: string;
    count: number;
  }>;
  usage?: NormalizedUsage;
  /** Cumulative model-request cost records for the subagent run. */
  costRecords?: ModelRequestCost[];
  error?: string;
  /** Why a valid provider response still did not complete the logical run. */
  terminalCause?: RunTerminationCause;
  /** SDK nested run result used to propagate/resume delegated approvals. */
  nestedRunResult?: unknown;
  /**
   * Per-file line-change evidence over `filesChanged`, captured automatically
   * by in-memory interception of editor-tool writes. Best-effort: shell-driven
   * edits outside the editor-tool set may not appear here.
   */
  diffStat?: DiffStatEntry[];
  /**
   * The last validation-shaped shell command the worker ran, with its exit
   * status and a truncated output excerpt. Absent when the worker ran no
   * validation command.
   */
  validation?: ValidationEvidence;
  /**
   * Absolute path of the worktree this worker was pinned into, when
   * the launch request's worktree resolved successfully.
   */
  worktreePath?: string;
}

/**
 * What a nested (synchronous) subagent tool returns to its parent.
 *
 * `status: 'interrupted'` is shared with {@link SubagentResult} and covers
 * two distinct causes, told apart by `interrupted` and `terminalCause`:
 * - An approval pause (`interrupted: true`, no `terminalCause`) — only this
 *   nested path can produce it, since only it stops mid-run for an approval.
 * - A terminal containment stop, e.g. `terminalCause: 'budget_exhausted'`
 *   (no `interrupted` flag) — the run is settled but unfinished, which is
 *   neither `completed` nor `failed`; the async and public-API paths can
 *   also produce this flavor.
 * `running` is unique to this type: the one-shot foreground result after
 * ownership transfers to the background.
 */
export type NestedSubagentResult = Omit<SubagentResult, 'status'> & {
  status: SubagentResult['status'] | 'running';
  /** True when the run paused for an approval the parent must surface. */
  interrupted?: boolean;
};

/** The only state exposed while an asynchronous run is live. */
export interface SubagentRunHandle {
  runId: string;
  /** Optional active-run alias; runId remains the canonical identity. */
  name?: string;
  role: string;
  status: 'running';
  task: string;
}

/** A bounded subagent text turn and the tools it invoked immediately before it. */
export interface TurnSnapshot {
  text: string;
  precedingToolCounts: Record<string, number>;
  truncated: boolean;
}

/**
 * Non-blocking progress snapshot of an async run, for the orchestrator's
 * mid-run "what is it doing" query. Never carries completion detail
 * (`finalText` and diff evidence stay on `SubagentResult` / `get_subagent_result`).
 */
export interface SubagentRunStatus {
  runId: string;
  /** Optional active-run alias retained in status snapshots. */
  name?: string;
  role: string;
  status:
    | 'running'
    | 'awaiting_approval'
    | 'waiting_for_answer'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'not_found';
  task: string;
  taskPreview: string;
  startedAt: number;
  elapsedMs: number;
  lastToolName?: string;
  lastToolAt?: number;
  toolCounts: Record<string, number>;
  turnHistory?: TurnSnapshot[];
  currentText?: string;
  /** Metadata-only progress for the tool call whose arguments are still streaming. */
  streamingTool?: { name: string; argumentCharCount: number };
  pendingToolCounts?: Record<string, number>;
  /** Registry-owned local observation used by the session UI projection. */
  lastObservation?: BackgroundTaskObservation;
  /** Compatibility timestamp retained for callers outside the control port. */
  lastActivityAt?: number;
  activityState?: 'active' | 'waiting' | 'cancelling';
  waitingReason?: 'provider' | 'approval' | 'answer';
  /** Immutable role resolution captured when the run was launched. */
  model?: { provider: string; id: string };
  /** Most recent provider request usage, never accumulated run usage. */
  latestUsage?: NormalizedUsage;
}
