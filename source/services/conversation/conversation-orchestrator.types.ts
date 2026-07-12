import type { ConversationService } from './conversation-service.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { ApprovedToolContext } from '../approval/approval-presentation-policy.js';
import type { PendingApproval } from '../../contracts/conversation.js';
import type { Message } from '../../types/message.js';
import type { NormalizedUsage, UsageAccumulator } from '../../utils/ai/token-usage.js';
import type { CodexRateLimitInfo } from './conversation-events.js';
import type { QueueStateSnapshot } from './conversation-adapter.js';

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
  onQueueStateChange(snapshot: QueueStateSnapshot): void;
  /**
   * A user message was queued behind an in-flight turn. The orchestrator has
   * NOT yet appended it to the message list. The UI should display it above
   * the input box until the queue actually starts processing the turn.
   */
  onQueuedMessagePending?(id: string, text: string): void;
  /**
   * The queue has started executing a previously-pending message. The
   * orchestrator has now appended it to the message list. The UI should
   * remove it from the pending indicator above the input box.
   */
  onQueuedMessageStarted?(id: string): void;
  /**
   * A user-cancelled pending message was just removed from the queue (e.g.
   * by pressing up-arrow on an empty input box). The UI should drop the
   * last entry from its pending-queued indicator so it stops being shown
   * above the input box.
   */
  onRemoveLastPendingMessage?(): void;
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
