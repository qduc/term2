import { describeError, isAbortLikeError } from '../../utils/error-helpers.js';
import { ASK_USER_DECLINE_RESULT } from '../../tools/agent/ask-user-constants.js';
import { createMessageIdFactory } from '../../utils/message-id-factory.js';
import type { ConversationOrchestratorConfig, AskUserAnswer } from './conversation-orchestrator.types.js';
import type { BotMessage, CommandMessage, UserMessage } from '../../types/message.js';
import { isUserMessage } from '../../types/message.js';
import type { ConversationTerminal, PendingApproval } from '../../contracts/conversation.js';
import { isDeniedReadApproveAnswer } from '../../contracts/conversation.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import { createStreamingSession } from '../../utils/streaming/streaming-session-factory.js';
import type { StreamingState } from '../../utils/conversation/conversation-utils.js';
import { enhanceApiKeyError, isMaxTurnsError } from '../../utils/conversation/conversation-utils.js';
import { clearStreamingBotMessage, computeNextMessages } from '../../utils/conversation/apply-conversation-result.js';
import {
  countUndoableUserTurnsFrom,
  findLastUndoableUserMessage,
  trimTrailingAssistantMessages,
} from '../../utils/conversation/message-utils.js';
import {
  annotateApprovedCommandMessage,
  filterPendingCommandMessagesForApproval,
} from '../approval/approval-presentation-policy.js';
import {
  formatUserTurnForDisplay,
  hasUserTurnContent,
  injectSkillIntoTurn,
  normalizeUserTurn,
  type UserTurn,
} from '../../types/user-turn.js';

const REASONING_RESPONSE_THROTTLE_MS = 200;

export class ConversationOrchestrator {
  private pendingApproval: PendingApproval | null = null;
  private askUserAnswers: AskUserAnswer[] = [];
  private currentAskUserQuestionIndex = 0;
  private readonly createMessageId: () => string;

  constructor(private config: ConversationOrchestratorConfig) {
    this.createMessageId = config.createMessageId ?? createMessageIdFactory(config.now);
  }

  updateCallbacks({
    onRestoreInput,
    onClear,
  }: Pick<ConversationOrchestratorConfig, 'onRestoreInput' | 'onClear'>): void {
    this.config.onRestoreInput = onRestoreInput;
    this.config.onClear = onClear;
  }

  getSubagentUsage(): NormalizedUsage | null {
    return this.config.subagentUsageAccumulator?.get() ?? null;
  }

  goToPreviousQuestion(): void {
    if (this.currentAskUserQuestionIndex <= 0) {
      return;
    }

    this.currentAskUserQuestionIndex -= 1;
    this.askUserAnswers.pop();
    this.config.ui.onAskUserGoBack(this.currentAskUserQuestionIndex, this.askUserAnswers.slice());
  }

  goToNextQuestion(): void {
    this.currentAskUserQuestionIndex += 1;
    this.config.ui.onAskUserAdvanceToNext(this.currentAskUserQuestionIndex);
  }

  async clearConversation(): Promise<void> {
    if (this.config.onClear) {
      await this.config.onClear();
    } else {
      this.config.conversationService.resetWithNewId(crypto.randomUUID());
    }

    this.config.messages.setMessages(() => []);
    this.config.approvedContext.current = null;
    this.pendingApproval = null;
    this.resetAskUserState();
    this.config.ui.onResetAll();
    this.config.usageAccumulator?.reset();
    this.config.subagentUsageAccumulator?.reset();
  }

  stopProcessing(): void {
    this.config.conversationService.abort();
    this.config.approvedContext.current = null;
    this.pendingApproval = null;
    this.resetAskUserState();
    this.config.ui.onResetTransient();
  }

  undoLastUserMessage(): { text: string; images?: UserTurn['images'] } | null {
    const messages = this.config.messages.getMessages();
    const lastUserIndex = findLastUndoableUserMessage(messages);
    if (lastUserIndex === -1) {
      return null;
    }

    const lastUserMessage = messages[lastUserIndex];
    const uiText = isUserMessage(lastUserMessage) ? lastUserMessage.text : '';
    this.config.conversationService.abort();
    const removed = this.config.conversationService.undoLastUserTurn();
    const restored = removed ?? { text: uiText };
    this.config.messages.setMessages((prev) => prev.slice(0, lastUserIndex));
    this.config.approvedContext.current = null;
    this.pendingApproval = null;
    this.resetAskUserState();
    this.config.ui.onResetTransient();

    return restored;
  }

  async retryLastToolOutput(): Promise<boolean> {
    this.config.conversationService.abort();
    this.config.approvedContext.current = null;
    this.pendingApproval = null;
    this.resetAskUserState();
    this.config.ui.onResetTransient();

    if (!this.config.conversationService.peekLastToolOutput()) {
      return false;
    }

    this.config.messages.setMessages((prev) => trimTrailingAssistantMessages(prev));
    this.config.ui.onTurnStart();

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
      this.createTurnSession('retryLastToolOutput');

    try {
      const result = await this.config.conversationService.retryLastToolOutput({
        onEvent: this.createOnEventHandler(applyConversationEvent),
      });

      if (!result) {
        return false;
      }

      applyConversationEvent({ type: 'final', finalText: '' } as any);
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
      return true;
    } catch (error) {
      this.logError('Error in retryLastToolOutput', error);

      if (isAbortLikeError(error)) {
        this.config.loggingService.debug('Suppressing abort error in retryLastToolOutput');
        return true;
      }

      const errorMessage = enhanceApiKeyError(describeError(error));
      this.appendBotError(errorMessage);
      this.config.ui.onApprovalResolved();
      return true;
    } finally {
      this.config.loggingService.debug('retryLastToolOutput finally block - resetting state');
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      this.config.ui.onTurnEnd();
    }
  }

  undoToUserMessage(uiIndex: number): string | null {
    const messages = this.config.messages.getMessages();
    const undoCount = countUndoableUserTurnsFrom(messages, uiIndex);
    if (undoCount === 0) {
      return null;
    }

    const selectedMessage = messages[uiIndex];
    const uiText = isUserMessage(selectedMessage) ? selectedMessage.text : '';

    this.config.conversationService.abort();
    const removed = this.config.conversationService.undoNUserTurns(undoCount);
    const restored = removed?.text ?? uiText;

    this.config.messages.setMessages((prev) => prev.slice(0, uiIndex));
    this.config.approvedContext.current = null;
    this.pendingApproval = null;
    this.resetAskUserState();
    this.config.ui.onResetTransient();

    return restored;
  }

  async sendUserMessage(input: string | UserTurn, options?: { bypassInputSurgeGuard?: boolean }): Promise<void> {
    const turn = normalizeUserTurn(input);
    if (!hasUserTurnContent(turn)) {
      return;
    }

    const userMessage: UserMessage = {
      id: this.createMessageId(),
      sender: 'user',
      text: formatUserTurnForDisplay(turn),
      ...(turn.skill ? { skill: turn.skill } : {}),
    };

    this.config.messages.appendMessages([userMessage]);
    this.config.logWriter?.append({ type: 'user_message', message: userMessage });
    this.config.ui.onTurnStart();

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
      this.createTurnSession('sendUserMessage');

    try {
      const turnToSend = turn.skill ? injectSkillIntoTurn(turn) : turn;
      const result = await this.config.conversationService.sendMessage(turnToSend, {
        onEvent: this.createOnEventHandler(applyConversationEvent),
        bypassInputSurgeGuard: options?.bypassInputSurgeGuard,
      });

      applyConversationEvent({ type: 'final', finalText: '' } as any);
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
    } catch (error) {
      this.logError('Error in sendUserMessage', error);

      if (isAbortLikeError(error)) {
        this.config.loggingService.debug('Suppressing abort error in sendUserMessage');
        return;
      }

      const rawErrorMessage = describeError(error);
      const errorMessage = enhanceApiKeyError(rawErrorMessage);
      const dropped = (error as any)?.rawEvent?.droppedUserMessage as { text: string; imageCount: number } | undefined;
      if (dropped) {
        this.config.messages.setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].sender === 'user') {
              return prev.slice(0, i);
            }
          }
          return prev;
        });
        this.config.onRestoreInput?.(dropped.text);
      }

      if (isMaxTurnsError(errorMessage)) {
        const pendingApproval: PendingApproval = {
          agentName: 'System',
          toolName: 'max_turns_exceeded',
          argumentsText: errorMessage,
          rawInterruption: null,
          isMaxTurnsPrompt: true,
        };
        this.pendingApproval = pendingApproval;
        this.config.ui.onApprovalRequested(pendingApproval);
      } else {
        this.appendBotError(errorMessage);
        this.config.ui.onApprovalResolved();
      }
    } finally {
      this.config.loggingService.debug('sendUserMessage finally block - resetting state');
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      this.config.ui.onTurnEnd();
    }
  }

  async handleApprovalDecision(answer: string, rejectionReason?: string, approvalAnswer?: string): Promise<void> {
    const pendingApproval = this.pendingApproval;
    if (!pendingApproval) {
      return;
    }

    const isMaxTurnsPrompt = pendingApproval.isMaxTurnsPrompt;
    const isAskUser = pendingApproval.toolName === 'ask_user';

    if (isAskUser && answer === 'y' && approvalAnswer !== ASK_USER_DECLINE_RESULT) {
      let questions: any[] = [];
      try {
        const parsed = JSON.parse(pendingApproval.argumentsText);
        questions = parsed.questions || [];
      } catch {
        // noop
      }

      let parsedAns: AskUserAnswer = approvalAnswer ?? '';
      const currentQuestion = questions[this.askUserAnswers.length];
      if (currentQuestion?.is_multi_select) {
        try {
          const maybeArray = JSON.parse(approvalAnswer ?? '');
          if (Array.isArray(maybeArray)) {
            parsedAns = maybeArray;
          }
        } catch {
          // keep plain string
        }
      }

      const nextAnswers = [...this.askUserAnswers, parsedAns];
      this.config.ui.onAskUserAnswerSubmitted(parsedAns);

      if (nextAnswers.length < questions.length) {
        this.askUserAnswers = nextAnswers;
        this.currentAskUserQuestionIndex = nextAnswers.length;
        this.config.ui.onAskUserAdvanceToNext(nextAnswers.length);
        return;
      }

      this.askUserAnswers = nextAnswers;
      this.currentAskUserQuestionIndex = nextAnswers.length;
      approvalAnswer = JSON.stringify(nextAnswers);
    }

    if (answer === 'y' || isDeniedReadApproveAnswer(answer)) {
      this.config.approvedContext.current = {
        callId: pendingApproval.callId,
        toolName: pendingApproval.toolName,
      };
    }

    this.config.ui.onApprovalResolved();
    this.pendingApproval = null;
    this.resetAskUserState();

    if (isMaxTurnsPrompt && answer === 'n') {
      this.config.ui.onTurnEnd();
      return;
    }

    if (isMaxTurnsPrompt && answer === 'y') {
      this.config.ui.onTurnStart();

      const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
        this.createTurnSession('maxTurnsContinuation');

      try {
        const result = await this.config.conversationService.sendMessage('Please continue with your previous task.', {
          onEvent: this.createOnEventHandler(applyConversationEvent),
        });

        applyConversationEvent({ type: 'final', finalText: '' } as any);
        this.applyServiceResult(result, streamingState, streamingState.latestUsage);
      } catch (error) {
        this.logError('Error in continuation after max turns', error);

        if (isAbortLikeError(error)) {
          this.config.loggingService.debug('Suppressing abort error in max turns continuation');
          return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        this.appendBotError(errorMessage);
        this.config.ui.onApprovalResolved();
      } finally {
        reasoningUpdater.flush();
        botResponseUpdater.cancel();
        this.config.ui.onTurnEnd();
      }

      return;
    }

    this.config.ui.onTurnStart();
    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
      this.createTurnSession('approvalDecision');

    try {
      const result = await this.config.conversationService.handleApprovalDecision(answer, rejectionReason, {
        onEvent: this.createOnEventHandler(applyConversationEvent),
        approvalAnswer,
      });
      applyConversationEvent({ type: 'final', finalText: '' } as any);
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
    } catch (error) {
      this.logError('Error in handleApprovalDecision', error);

      if (isAbortLikeError(error)) {
        this.config.loggingService.debug('Suppressing abort error in handleApprovalDecision');
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.appendBotError(errorMessage);
      this.config.ui.onApprovalResolved();
    } finally {
      this.config.loggingService.debug('handleApprovalDecision finally block - resetting state');
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      this.config.ui.onTurnEnd();
    }
  }

  private createTurnSession(label: string) {
    return createStreamingSession(
      {
        appendMessages: this.config.messages.appendMessages,
        setMessages: this.config.messages.setMessages,
        trimMessages: this.config.messages.trimMessages,
        annotateCommandMessage: (msg) => this.annotateCommandMessage(msg),
        loggingService: this.config.loggingService,
        setLastUsage: (usage) => this.config.ui.onUsageUpdate(usage),
        setCodexRateLimit: (rateLimit) => this.config.ui.onRateLimitUpdate(rateLimit),
        reasoningThrottleMs: REASONING_RESPONSE_THROTTLE_MS,
        now: this.config.now,
      },
      label,
    );
  }

  private createOnEventHandler(baseOnEvent: (event: any) => void) {
    return (event: any) => {
      const eventType = typeof event?.type === 'string' ? event.type : undefined;
      if (eventType === 'reasoning_delta') {
        this.config.ui.onStreamingThinkingStarted((this.config.now ?? Date.now)());
      } else if (eventType && this.clearsThinkingIndicator(eventType)) {
        this.config.ui.onStreamingThinkingCleared();
      }

      if (eventType === 'tool_call_streaming_delta') {
        this.config.ui.onStreamingToolInfo({ toolName: event.toolName, argumentCharCount: event.argumentCharCount });
      } else if (eventType === 'tool_started' || eventType === 'text_delta' || eventType === 'final') {
        this.config.ui.onStreamingToolInfo(null);
      }

      if (event?.type === 'user_message_consumed_for_abort') {
        this.config.messages.setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const msg = prev[i];
            if (isUserMessage(msg)) {
              if (msg.consumedForAbort) return prev;
              const next = prev.slice();
              next[i] = { ...msg, consumedForAbort: true };
              return next;
            }
          }
          return prev;
        });
        return;
      }

      baseOnEvent(event);
      if (event?.type === 'subagent_completed' && event?.result?.usage) {
        this.config.subagentUsageAccumulator?.add(event.result.usage);
      }
    };
  }

  private applyServiceResult(
    result: ConversationTerminal | null,
    streamingState: StreamingState,
    latestStreamedUsage?: NormalizedUsage | null,
  ): void {
    if (!result) {
      return;
    }

    if (result.type === 'approval_required') {
      if (result.usage) {
        this.config.ui.onUsageUpdate(latestStreamedUsage ?? result.usage);
      }

      this.pendingApproval = result.approval;
      this.config.messages.setMessages((prev) =>
        this.config.messages.trimMessages(filterPendingCommandMessagesForApproval(prev, result.approval)),
      );
      this.config.ui.onApprovalRequested({ ...result.approval, llmAdvisory: (result.approval as any).llmAdvisory });
      this.config.notifier?.approvalNeeded();
      return;
    }

    this.pendingApproval = null;
    this.config.messages.setMessages(
      (prev) =>
        computeNextMessages({
          prev,
          result,
          streamingState,
          createMessageId: this.createMessageId,
          trimMessages: this.config.messages.trimMessages,
          annotateCommandMessage: (msg) => this.annotateCommandMessage(msg),
        }).next,
    );
    if (result.type === 'response' && streamingState.currentBotMessageId !== null) {
      clearStreamingBotMessage(streamingState);
    }
    this.config.ui.onApprovalResolved();
    this.config.notifier?.turnComplete();
    if (result.usage) {
      this.config.usageAccumulator?.add(result.usage);
      this.config.ui.onUsageUpdate(latestStreamedUsage ?? result.usage);
    }
  }

  private annotateCommandMessage(cmdMsg: CommandMessage): CommandMessage {
    const approvedMessage = annotateApprovedCommandMessage(cmdMsg, this.config.approvedContext.current);
    const matchedByToolName =
      approvedMessage !== cmdMsg &&
      !this.config.approvedContext.current?.callId &&
      Boolean(this.config.approvedContext.current?.toolName) &&
      this.config.approvedContext.current?.toolName === cmdMsg.toolName;

    if (matchedByToolName) {
      this.config.approvedContext.current = null;
    }

    return approvedMessage;
  }

  private clearsThinkingIndicator(eventType: string): boolean {
    return (
      eventType === 'text_delta' ||
      eventType === 'tool_started' ||
      eventType === 'tool_call_streaming_delta' ||
      eventType === 'final'
    );
  }

  private resetAskUserState(): void {
    this.askUserAnswers = [];
    this.currentAskUserQuestionIndex = 0;
  }

  private appendBotError(errorMessage: string): void {
    const botErrorMessage: BotMessage = {
      id: this.createMessageId(),
      sender: 'bot',
      status: 'finalized',
      text: `Error: ${errorMessage}`,
    };
    this.config.messages.appendMessages([botErrorMessage]);
  }

  private logError(message: string, error: unknown): void {
    this.config.loggingService.error(message, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...(error instanceof Error && (error as any).eventKind ? { eventKind: (error as any).eventKind } : {}),
    });
  }
}
