import type { ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import type { CommandMessage } from '../tools/types.js';
import type { NormalizedUsage } from '../utils/ai/token-usage.js';
import type { PersistedAssistantTurnItem } from '../services/conversation/conversation-persistence-types.js';

export type ReasoningEffortSetting = ModelSettingsReasoningEffort | 'default';

export interface LLMAdvisory {
  reasoning: string;
  approved: boolean;
  model: string;
  source?: 'llm' | 'system';
  /** Set when the LLM call failed; the approved/reasoning values are placeholders. */
  isError?: boolean;
}

/** Answer strings for the denied-read approval variant (see prepareContinuation). */
export const DENIED_READ_APPROVE_ANSWERS: ReadonlySet<string> = new Set([
  'allow-once',
  'allow-remember',
  'unsandboxed-once',
]);
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
