import type { CommandMessage } from '../tools/types.js';
import type { NormalizedUsage } from '../utils/ai/token-usage.js';
import type { ModelRequestCost } from '../services/cost/model-cost.js';
import type { Item } from './conversation-items.js';
import type { RunBudgetEvent } from '../services/agent-runtime/run-budget.js';

export type ReasoningEffortSetting = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type LLMAdvisoryRiskLevel = 'low' | 'medium' | 'high';
export type LLMAdvisoryAuthorization = 'explicit' | 'implied' | 'weak' | 'unknown';
export type LLMAdvisoryConfidence = 'high' | 'low';

export interface LLMAdvisory {
  reasoning: string;
  approved: boolean;
  model: string;
  /** Structured reviewer metadata used by the fail-closed auto-approve gate. */
  riskLevel?: LLMAdvisoryRiskLevel;
  authorization?: LLMAdvisoryAuthorization;
  confidence?: LLMAdvisoryConfidence;
  source?: 'llm' | 'system';
  /** Set when the LLM call failed; the approved/reasoning values are placeholders. */
  isError?: boolean;
}

export type DeniedReadApproveAnswer = 'allow-once' | 'allow-remember' | 'unsandboxed-once';
export type EditSessionApproveAnswer = 'allow-edit-file-session' | 'allow-edit-folder-session';
export type PostExecuteDecision = 'approve' | 'reject' | DeniedReadApproveAnswer;
export type DockerHostControlApproveAnswer = 'docker-allow-once' | 'docker-allow-session' | 'docker-allow-project';
export const DOCKER_HOST_CONTROL_APPROVE_ANSWERS: ReadonlySet<DockerHostControlApproveAnswer> = new Set([
  'docker-allow-once',
  'docker-allow-session',
  'docker-allow-project',
]);
export function isDockerHostControlApproveAnswer(answer: string | undefined): answer is DockerHostControlApproveAnswer {
  return (
    typeof answer === 'string' && DOCKER_HOST_CONTROL_APPROVE_ANSWERS.has(answer as DockerHostControlApproveAnswer)
  );
}
export const READ_FILE_SESSION_APPROVE_ANSWER = 'allow-folder-session';

/**
 * Read-only tools whose approval prompt offers "allow this folder for this
 * session". The grant is session-scoped and shared, so approving a folder from
 * one of these prompts also covers the others.
 */
const FOLDER_SESSION_READ_TOOLS: ReadonlySet<string> = new Set(['read_file', 'grep', 'glob']);

export function supportsFolderSessionRead(toolName: string | undefined): boolean {
  return typeof toolName === 'string' && FOLDER_SESSION_READ_TOOLS.has(toolName);
}

export function isReadFileSessionApproveAnswer(
  answer: string | undefined,
): answer is typeof READ_FILE_SESSION_APPROVE_ANSWER {
  return answer === READ_FILE_SESSION_APPROVE_ANSWER;
}

/** Answer strings for the denied-read approval variant (see prepareContinuation). */
export const DENIED_READ_APPROVE_ANSWERS: ReadonlySet<DeniedReadApproveAnswer> = new Set<DeniedReadApproveAnswer>([
  'allow-once',
  'allow-remember',
  'unsandboxed-once',
]);

export function isDeniedReadApproveAnswer(answer: string | undefined): answer is DeniedReadApproveAnswer {
  return typeof answer === 'string' && DENIED_READ_APPROVE_ANSWERS.has(answer as DeniedReadApproveAnswer);
}
/** The deny answer for the denied-read variant (treated as a rejection). */
export const DENIED_READ_DENY_ANSWER = 'deny';

/**
 * Metadata attached to a shell approval when the sandbox denied a read and the agent
 * retried. Drives the 4-option denied-read prompt (allow once / allow & remember /
 * run unsandboxed once / deny) instead of the standard Approve/Reject.
 */
export interface DeniedReadMetadata {
  /** Resolved real path of the denied file/dir (for display; ~-compacted in UI). */
  deniedPath: string;
  /** What "allow once"/"remember" would add to allowRead. */
  suggestedParent: string;
  /** Suppresses the "allow and remember" option for credential-shaped paths. */
  sensitive: boolean;
  /** The command that triggered the denied read. */
  command: string;
}

export interface ApprovalDescriptor {
  agentName: string;
  toolName: string;
  argumentsText: string;
  rawInterruption: unknown;
  callId?: string;
  llmAdvisory?: LLMAdvisory;
  deniedRead?: DeniedReadMetadata;
  /** Present for a file-mutating tool whose target is outside the workspace. */
  outsideWorkspaceEdit?: {
    path: string;
    folder: string;
  };
  /**
   * This approval is the Docker host-control capability prompt, not an ordinary one.
   *
   * Resolved here because the answer depends on a per-session record of sandbox
   * Docker blocks, and the UI has no session identity to consult it with. The
   * prompt and the continuation must agree, or a Docker request stalls forever:
   * an ordinary `y` cannot resume it, and a Docker grant cannot resume an
   * ordinary one.
   */
  dockerHostControl?: boolean;
  /** Application-owned post-execute gate; never pass this through SDK approval APIs. */
  postExecute?: PostExecuteApprovalToken;
  /** Main-run budget/stall evidence held at a real continuation boundary. */
  runBudgetEvent?: RunBudgetEvent;
  /**
   * This pause is a system check-in, not a tool approval.
   *
   * Check-ins ride the approval transport because it is the only thing that can
   * hold a run at a continuation boundary, but there is no tool to allow or
   * deny: the only answers are continue and stop, and a denial reason has
   * nowhere to go. Every branch that must tell the two apart reads this field.
   */
  checkIn?: ApprovalCheckInKind;
}

/** Which system check-in a pause represents. */
export type ApprovalCheckInKind = 'max_turns' | 'run_budget';

/**
 * The tool name a check-in carries on the approval transport.
 *
 * It names no real tool. It exists because the descriptor requires a tool name
 * and because logs and snapshots already record this string; branch on
 * `checkIn` instead, never on this value.
 */
export const CHECK_IN_TOOL_NAME = 'max_turns_exceeded';

export interface PostExecuteApprovalToken {
  kind: 'post_execute';
  sessionId: string;
  epoch: string | number;
  revision: number;
  ids: readonly string[];
}

/** Canonical approval data. Reuses the established approval descriptor shape. */
export type Approval = ApprovalDescriptor;

export interface ApprovalRequiredTerminal {
  type: 'approval_required';
  approval: ApprovalDescriptor;
  usage?: NormalizedUsage;
  /** Cumulative model-request cost records for the run up to this pause. */
  costRecords?: ModelRequestCost[];
}

export interface FinalTerminal {
  type: 'response';
  commandMessages: CommandMessage[];
  finalText: string;
  /** @deprecated derived compatibility only; turnItems is authoritative. */
  reasoningText?: string;
  usage?: NormalizedUsage;
  /** Cumulative model-request cost records for the completed run. */
  costRecords?: ModelRequestCost[];
  turnItems?: Item[];
}

export type ConversationTerminal = ApprovalRequiredTerminal | FinalTerminal;

export interface PendingApproval extends ApprovalDescriptor {
  /** Human judgement request produced by the staged budget/stall sensor. */
  runBudgetEvent?: RunBudgetEvent;
}
