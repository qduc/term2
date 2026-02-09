import type { ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import type { CommandMessage } from '../tools/types.js';
import type { NormalizedUsage } from '../utils/token-usage.js';

export type ReasoningEffortSetting = ModelSettingsReasoningEffort | 'default';

export interface ApprovalDescriptor {
  agentName: string;
  toolName: string;
  argumentsText: string;
  rawInterruption: unknown;
  callId?: string;
}

export interface ApprovalRequiredTerminal {
  type: 'approval_required';
  approval: ApprovalDescriptor;
}

export interface FinalTerminal {
  type: 'response';
  commandMessages: CommandMessage[];
  finalText: string;
  reasoningText?: string;
  usage?: NormalizedUsage;
}

export type ConversationTerminal = ApprovalRequiredTerminal | FinalTerminal;

export interface PendingApproval extends ApprovalDescriptor {
  isMaxTurnsPrompt?: boolean;
}
