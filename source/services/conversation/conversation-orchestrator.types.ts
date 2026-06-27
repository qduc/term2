import type { ConversationService } from './conversation-service.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { ApprovedToolContext } from '../approval/approval-presentation-policy.js';
import type { PendingApproval } from '../../contracts/conversation.js';
import type { Message } from '../../types/message.js';
import type { NormalizedUsage, UsageAccumulator } from '../../utils/ai/token-usage.js';
import type { CodexRateLimitInfo } from './conversation-events.js';

export type AskUserAnswer = string | string[];

export interface ConversationNotifier {
  approvalNeeded(): void;
  turnComplete(): void;
}

export interface MessagePort {
  getMessages(): readonly Message[];
  setMessages(updater: (prev: Message[]) => Message[]): void;
  appendMessages(additions: readonly Message[]): void;
  trimMessages(msgs: Message[]): Message[];
}

export interface UIPort {
  onTurnStart(): void;
  onTurnEnd(): void;
  onApprovalRequested(approval: PendingApproval): void;
  onApprovalResolved(): void;
  onUsageUpdate(usage: NormalizedUsage): void;
  onRateLimitUpdate(rateLimit: CodexRateLimitInfo): void;
  onRateLimitClear(): void;
  onResetTransient(): void;
  onResetAll(): void;
  onStreamingThinkingStarted(timestamp: number): void;
  onStreamingThinkingCleared(): void;
  onStreamingToolInfo(info: { toolName?: string; argumentCharCount: number } | null): void;
  onAskUserAnswerSubmitted(answer: AskUserAnswer): void;
  onAskUserAdvanceToNext(nextIndex: number): void;
  onAskUserGoBack(currentIndex: number, answers: readonly AskUserAnswer[]): void;
}

export interface ConversationOrchestratorConfig {
  conversationService: ConversationService;
  loggingService: ILoggingService;
  messages: MessagePort;
  ui: UIPort;
  approvedContext: { current: ApprovedToolContext | null };
  usageAccumulator?: UsageAccumulator;
  subagentUsageAccumulator?: UsageAccumulator;
  notifier?: ConversationNotifier;
  onRestoreInput?: (text: string) => void;
  onClear?: () => void | Promise<void>;
  now?: () => number;
  createMessageId?: () => string;
  logWriter?: { append: (event: any) => void };
}
