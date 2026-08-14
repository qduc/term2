import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { CommandMessage } from '../../tools/types.js';
import type { SubagentResult } from '../subagents/types.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import type { UserMessage } from '../../types/message.js';
import type {
  SavedAppMode,
  PersistedAssistantTurn,
  PersistedAssistantTurnItem,
} from '../conversation/conversation-persistence-types.js';
import type { ModelRequestCost } from '../cost/model-cost.js';

export const LOG_ENVELOPE_VERSION = 3;

/**
 * Streaming `assistant_journal_delta` events are written to a per-session
 * sidecar instead of the canonical log. They are only ever read to reconstruct
 * a turn that never produced a final `assistant_turn`, so the sidecar is
 * dropped when a session closes with no unsettled turn.
 *
 * The suffix deliberately does **not** end in `.jsonl`: `listConversations`
 * enumerates the conversations directory with a `*.jsonl` glob and would
 * otherwise surface the sidecar as a phantom conversation.
 */
export const DELTA_SIDECAR_SUFFIX = '.deltas';

/** Map a canonical `<sessionId>.jsonl` path to its delta sidecar path. */
export function deltaSidecarPathFor(logFilePath: string): string {
  return logFilePath.replace(/\.jsonl$/, '') + DELTA_SIDECAR_SUFFIX;
}

/** Event types routed to the delta sidecar rather than the canonical log. */
export const SIDECAR_EVENT_TYPES = new Set<string>(['assistant_journal_delta']);

export interface StateSnapshot {
  history: ProviderInputItem[];
  previousResponseId: string | null;
  toolLedger: SavedToolExecution[];
  model?: string;
  provider?: string;
}

export interface AssistantTurnState {
  previousResponseId: string | null;
  model?: string;
  provider?: string;
}

export interface SessionInitEvent {
  type: 'session_init';
  id: string;
  createdAt: string;
  projectPath?: string;
  sshHost?: string;
  appMode?: SavedAppMode;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  forkedFrom?: string;
}

export interface SettingsChangedEvent {
  type: 'settings_changed';
  key: string;
  value: unknown;
}

export interface UserMessageEvent {
  type: 'user_message';
  message: UserMessage;
}

export interface ToolStartedLogEvent {
  type: 'tool_started';
  turnId?: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

export interface ToolResultLogEvent {
  type: 'tool_result';
  turnId?: string;
  callId: string;
  toolName: string;
  status: 'completed' | 'failed' | 'aborted' | 'unknown';
  output?: unknown;
  historyItems?: unknown[];
}

export interface CommandMessageLogEvent {
  type: 'command_message';
  message: CommandMessage;
}

export interface ApprovalRequiredLogEvent {
  type: 'approval_required';
  turnId?: string;
  approval: {
    callId?: string;
    toolName: string;
    argumentsText?: string;
    agentName?: string;
  };
}

export interface ApprovalResolvedLogEvent {
  type: 'approval_resolved';
  turnId?: string;
  answer: 'y' | 'n';
  rejectionReason?: string;
}

/** Observation-only evidence for a later OpenAI selector review. */
export interface OpenAIRootSelectorParityLogEvent {
  type: 'openai_root_selector_parity';
  version: 2;
  turnId?: string;
  eligible: boolean;
  matches: boolean;
  /** Fixed diagnostic enum, only emitted when eligibility is false. */
  failure?:
    | 'model_unavailable'
    | 'identity_unavailable'
    | 'no_accepted_checkpoint'
    | 'missing_successor_proof'
    | 'lineage_mismatch'
    | 'invalid_planned_snapshot'
    | 'identity_mismatch'
    | 'origin_mismatch'
    | 'revision_not_advanced'
    | 'history_not_extended'
    | 'history_prefix_mismatch';
}

/** Sanitized, observation-only evidence for the OpenAI root checkpoint lifecycle. */
export interface OpenAIRootCheckpointLifecycleLogEvent {
  type: 'openai_root_checkpoint_lifecycle';
  version: 1;
  turnId?: string;
  stage: 'candidate' | 'publication';
  outcome:
    | 'observed'
    | 'missing_prefix_binding'
    | 'not_prepared'
    | 'already_consumed'
    | 'input_mismatch'
    | 'missing_response_id'
    | 'invalid_lineage'
    | 'lineage_rejected'
    | 'promoted'
    | 'history_not_committed'
    | 'candidate_not_promoted';
}

/**
 * Streaming fragment of assistant output (text or reasoning) that has not yet
 * been materialized as a durable persisted item. These entries are intentionally
 * non-critical (no fsync) so we can keep per-token write cost down while still
 * surviving a crash with at-most-fragment granularity.
 */
export interface AssistantJournalDeltaLogEvent {
  type: 'assistant_journal_delta';
  turnId: string;
  /** Per-turn monotonic sequence number; resets when a new turn begins. */
  seq: number;
  /** 'text' for assistant text, 'reasoning' for reasoning fragments. */
  kind: 'text' | 'reasoning';
  delta: string;
}

/**
 * Durable provider-backed item that has materialized during streaming. These
 * entries ARE critical recovery events: the next resumed request must not see
 * them again from the provider, so we fsync them and use them as the preferred
 * transcript source for any interrupted turn.
 */
export interface AssistantJournalItemLogEvent {
  type: 'assistant_journal_item';
  turnId: string;
  /** Per-turn monotonic sequence number; resets when a new turn begins. */
  seq: number;
  /** Normalized item shape so journal replay can rehydrate the transcript. */
  item: PersistedAssistantTurnItem;
}

export interface SubagentStartedLogEvent {
  type: 'subagent_started';
  agentId: string;
  role: string;
  task: string;
  /** Original public delegation tool, retained only for transcript compatibility. */
  parentTool?: string;
  async?: boolean;
}

export interface SubagentToolStartedLogEvent {
  type: 'subagent_tool_started';
  agentId: string;
  role: string;
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
}

export interface SubagentCompletedLogEvent {
  type: 'subagent_completed';
  result: SubagentResult;
  /** Cumulative model-request cost records for the subagent run. */
  costRecords?: ModelRequestCost[];
}

export interface SubagentInterruptedLogEvent {
  type: 'subagent_interrupted';
  agentId: string;
  role: string;
  finalText: string;
}

export interface SubagentTransferredLogEvent {
  type: 'subagent_transferred';
  agentId: string;
  runId: string;
  role: string;
}

export interface SubagentQuestionLogEvent {
  type: 'subagent_question';
  messageId: string;
  runId: string;
  name?: string;
  role: string;
  question: string;
}

/** Durable observation that a session-owned shell job was launched. */
export interface BackgroundShellStartedLogEvent {
  type: 'background_shell_started';
  jobId: string;
  command: string;
}

/** Durable terminal observation for a background shell job. */
export interface BackgroundShellCompletedLogEvent {
  type: 'background_shell_completed';
  jobId: string;
  command: string;
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  /** Normalized, bounded shell output. */
  output: string;
  error?: string;
}

/** Durable observation that a shell watch fired matched output. */
export interface BackgroundShellOutputLogEvent {
  type: 'background_shell_output';
  jobId: string;
  command: string;
  watchId: string;
  /** Per-watch monotonic firing ordinal; the notification messageId dedupe key. */
  seq: number;
  /** Bounded, complete-line match text carried by the firing. */
  matchedLines: string;
  /** Present when the job's retained buffer evicted bytes before this firing. */
  droppedBytes?: number;
}

export interface ErrorLogEvent {
  type: 'error';
  message: string;
  kind?: string;
  stack?: string;
}

export interface AssistantTurnEvent {
  type: 'assistant_turn';
  turnId?: string;
  turn: PersistedAssistantTurn;
  /** Whole-run cumulative usage for this assistant turn. */
  usage?: NormalizedUsage;
  /** Footer-compatible usage from the last streamed model turn, when available. */
  displayUsage?: NormalizedUsage;
  /** Cumulative model-request cost records for the completed turn. */
  costRecords?: ModelRequestCost[];
  state?: AssistantTurnState;
  /** Present in v2 logs. New v3 logs use `state` to avoid cumulative snapshots. */
  snapshot?: StateSnapshot;
}

export interface UndoEvent {
  type: 'undo';
  removedUserTurns: number;
  snapshot: StateSnapshot;
}

export interface SessionClearedEvent {
  type: 'session_cleared';
}

export type LogEvent =
  | SessionInitEvent
  | SettingsChangedEvent
  | UserMessageEvent
  | ToolStartedLogEvent
  | ToolResultLogEvent
  | CommandMessageLogEvent
  | ApprovalRequiredLogEvent
  | ApprovalResolvedLogEvent
  | OpenAIRootSelectorParityLogEvent
  | OpenAIRootCheckpointLifecycleLogEvent
  | SubagentStartedLogEvent
  | SubagentToolStartedLogEvent
  | SubagentCompletedLogEvent
  | SubagentInterruptedLogEvent
  | SubagentTransferredLogEvent
  | SubagentQuestionLogEvent
  | BackgroundShellStartedLogEvent
  | BackgroundShellCompletedLogEvent
  | BackgroundShellOutputLogEvent
  | ErrorLogEvent
  | AssistantTurnEvent
  | AssistantJournalDeltaLogEvent
  | AssistantJournalItemLogEvent
  | UndoEvent
  | SessionClearedEvent;

export interface TruncatedLogEvent {
  type: string;
  truncated: true;
  originalSize: number;
}

export type PersistedLogEvent = LogEvent | TruncatedLogEvent;

/**
 * Narrowing predicate for the storage-only truncation marker. Uses an `in`
 * check (plus an explicit `=== true`) rather than the `type` discriminant
 * because `TruncatedLogEvent.type` is a plain `string` that overlaps with
 * every log-event type.
 */
export function isTruncatedLogEvent(event: PersistedLogEvent): event is TruncatedLogEvent {
  return 'truncated' in event && event.truncated === true;
}

export interface LogEnvelope<TEvent = LogEvent> {
  v: number;
  seq: number;
  ts: string;
  event: TEvent;
}

export const AGENT_AFFECTING_SETTINGS = new Set<string>([
  'agent.model',
  'agent.provider',
  'agent.reasoningEffort',
  'agent.temperature',
  'app.mentorMode',
  'app.liteMode',
  'app.planMode',
  'app.orchestratorMode',
]);
