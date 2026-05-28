import type { ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import type { CommandMessage } from '../tools/types.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import type { PersistedAssistantTurnItem } from '../services/conversation-persistence-types.js';

export type ReasoningEffortSetting = ModelSettingsReasoningEffort | 'default';

export interface LLMAdvisory {
  reasoning: string;
  approved: boolean;
  model: string;
  source?: 'llm' | 'system';
  /** Set when the LLM call failed; the approved/reasoning values are placeholders. */
  isError?: boolean;
}

export interface ApprovalDescriptor {
  agentName: string;
  toolName: string;
  argumentsText: string;
  rawInterruption: unknown;
  callId?: string;
  llmAdvisory?: LLMAdvisory;
}

export interface ApprovalRequiredTerminal {
  type: 'approval_required';
  approval: ApprovalDescriptor;
  usage?: NormalizedUsage;
}

export interface FinalTerminal {
  type: 'response';
  commandMessages: CommandMessage[];
  finalText: string;
  /** @deprecated derived compatibility only; turnItems is authoritative. */
  reasoningText?: string;
  usage?: NormalizedUsage;
  turnItems?: PersistedAssistantTurnItem[];
}

export type ConversationTerminal = ApprovalRequiredTerminal | FinalTerminal;

export interface PendingApproval extends ApprovalDescriptor {
  isMaxTurnsPrompt?: boolean;
}
