import type { AgentInputItem } from '@openai/agents';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { CommandMessage } from '../../tools/types.js';
import type { SubagentResult } from '../subagents/types.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import type {
  SavedAppMode,
  SavedMessage,
  PersistedAssistantTurn,
} from '../conversation/conversation-persistence-types.js';

export const LOG_ENVELOPE_VERSION = 3;

export interface StateSnapshot {
  history: AgentInputItem[];
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
  message: SavedMessage;
}

export interface ToolStartedLogEvent {
  type: 'tool_started';
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

export interface ToolResultLogEvent {
  type: 'tool_result';
  callId: string;
  toolName: string;
  status: 'completed' | 'failed' | 'aborted';
  output?: unknown;
  historyItems?: unknown[];
}

export interface CommandMessageLogEvent {
  type: 'command_message';
  message: CommandMessage;
}

export interface ApprovalRequiredLogEvent {
  type: 'approval_required';
  approval: {
    callId?: string;
    toolName: string;
    argumentsText?: string;
    agentName?: string;
  };
}

export interface ApprovalResolvedLogEvent {
  type: 'approval_resolved';
  answer: 'y' | 'n';
  rejectionReason?: string;
}

export interface SubagentStartedLogEvent {
  type: 'subagent_started';
  agentId: string;
  role: string;
  task: string;
}

export interface SubagentCompletedLogEvent {
  type: 'subagent_completed';
  result: SubagentResult;
}

export interface ErrorLogEvent {
  type: 'error';
  message: string;
  kind?: string;
  stack?: string;
}

export interface AssistantTurnEvent {
  type: 'assistant_turn';
  turn: PersistedAssistantTurn;
  /** Whole-run cumulative usage for this assistant turn. */
  usage?: NormalizedUsage;
  /** Footer-compatible usage from the last streamed model turn, when available. */
  displayUsage?: NormalizedUsage;
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
  | SubagentStartedLogEvent
  | SubagentCompletedLogEvent
  | ErrorLogEvent
  | AssistantTurnEvent
  | UndoEvent
  | SessionClearedEvent;

export interface LogEnvelope {
  v: number;
  seq: number;
  ts: string;
  event: LogEvent;
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
