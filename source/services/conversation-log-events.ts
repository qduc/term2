import type { AgentInputItem } from '@openai/agents';
import type { NormalizedUsage } from '../utils/token-usage.js';
import type { CommandMessage } from '../tools/types.js';
import type { SubagentResult } from './subagents/types.js';
import type { SavedToolExecution } from './tool-execution-ledger.js';
import type { SavedAppMode, SavedMessage } from './conversation-persistence-types.js';

export const LOG_ENVELOPE_VERSION = 1;

export interface StateSnapshot {
  history: AgentInputItem[];
  previousResponseId: string | null;
  toolLedger: SavedToolExecution[];
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

export interface AssistantFinalEvent {
  type: 'assistant_final';
  message: SavedMessage;
  finalText: string;
  reasoningText?: string;
  usage?: NormalizedUsage;
  snapshot: StateSnapshot;
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
  | AssistantFinalEvent
  | UndoEvent
  | SessionClearedEvent;

export interface LogEnvelope {
  v: typeof LOG_ENVELOPE_VERSION;
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
