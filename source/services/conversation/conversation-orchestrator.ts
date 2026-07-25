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
import type { BackgroundSubagentNotification } from '../subagents/subagent-notification-store.js';

const REASONING_RESPONSE_THROTTLE_MS = 200;

/**
 * Render settled background runs as one instruction to the main agent. Previews
 * are already capped by the notification store, so the full output is offered
 * by reference rather than inlined.
 */
function formatBackgroundSubagentNotifications(notifications: readonly BackgroundSubagentNotification[]): string {
  const noun = notifications.length === 1 ? 'run' : 'runs';
  const entries = notifications.map((notification) => {
    const lines = [
      `- runId: ${notification.runId} | role: ${notification.role} | status: ${notification.status}`,
      ...(notification.error ? [`  error: ${notification.error}`] : []),
      ...(notification.preview ? [`  preview: ${notification.preview}`] : []),
    ];
    return lines.join('\n');
  });

  return [
    `Background subagent ${noun} finished (${notifications.length}). This is an automatic system notification, not a user message.`,
    '',
    ...entries,
    '',
    'Call get_subagent_result(runId) for the full report of any run above.',
  ].join('\n');
}

export class ConversationOrchestrator {
  private pendingApproval: PendingApproval | null = null;
  private askUserAnswers: AskUserAnswer[] = [];
  private currentAskUserQuestionIndex = 0;
  private readonly createMessageId: () => string;
  readonly #directlyAppendedMessageIds = new Set<string>();
  /**
   * Turns this orchestrator currently owns. `ui.onTurnStart` cannot be counted
   * instead: the queue observer emits it unbalanced when a queued submission is
   * popped after the preceding turn already ended.
   */
  #activeTurns = 0;
  /** True while {@link stopProcessing} is tearing the conversation down. */
  #stoppingByUser = false;

  constructor(private config: ConversationOrchestratorConfig) {
    this.createMessageId = config.createMessageId ?? createMessageIdFactory(config.now);
    // Wire queue state observer from the adapter through to the UI.
    if (typeof config.conversationService.setQueueStateObserver === 'function') {
      config.conversationService.setQueueStateObserver((snapshot) => {
        config.ui.onQueueStateChange(snapshot);
      });
    }
    // When the queue has actually popped the next head and is about to start
    // its turn, the orchestrator appends the user message to the message list
    // (with the timeline the turn actually started at) and clears the pending
    // indicator above the input box.
    if (typeof config.conversationService.setQueuedTurnStartObserver === 'function') {
      config.conversationService.setQueuedTurnStartObserver((execution) => {
        const wasAlreadyStarted = this.moveQueuedMessageIntoList(execution.requestId, execution.input);
        if (!wasAlreadyStarted) {
          // A queued submission's original turn-start may have been balanced
          // by the preceding turn completing. Reassert processing when this
          // turn actually becomes the queue head.
          config.ui.onTurnStart();
        }
      });
    }
    // A background subagent run can settle at any time, including while the
    // conversation is idle and nothing would otherwise wake the agent.
    if (typeof config.conversationService.setBackgroundSubagentNotificationObserver === 'function') {
      config.conversationService.setBackgroundSubagentNotificationObserver(() => {
        void this.#deliverBackgroundSubagentNotifications();
      });
    }
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
    this.#directlyAppendedMessageIds.clear();
  }

  stopProcessing(): void {
    // The user asked everything to stop, so background subagent runs go too.
    // Undo and retry, by contrast, only abort the turn.
    //
    // Cancelling those runs makes each of them emit its own completion event,
    // so the notification queue must be suppressed and then dropped: the user
    // already knows the runs stopped, and waking the agent to say so is the
    // opposite of what they asked for.
    this.#stoppingByUser = true;
    try {
      this.config.conversationService.interruptFromUser();
      this.config.messages.setMessages((messages) =>
        messages.map((message) =>
          message.sender === 'command' && message.status === 'running'
            ? { ...message, status: 'aborted' as const }
            : message,
        ),
      );
      this.config.approvedContext.current = null;
      this.pendingApproval = null;
      this.resetAskUserState();
      this.config.ui.onResetTransient();
      this.#directlyAppendedMessageIds.clear();
      this.config.conversationService.backgroundSubagentNotifications?.drain();
    } finally {
      this.#stoppingByUser = false;
    }
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
    this.#directlyAppendedMessageIds.clear();

    return restored;
  }

  /**
   * Cancel the most recently queued message and return its text so the UI
   * can move it back into the input box. Returns null when there are no
   * pending queued messages, the service cannot cancel the tail item, or the
   * service does not implement cancellation.
   */
  async removeLastQueuedPendingMessage(): Promise<string | null> {
    const service = this.config.conversationService;
    if (typeof service.removeLastQueuedItem !== 'function') {
      return null;
    }

    const result = await service.removeLastQueuedItem();
    if (!result) return null;

    // The pending indicator above the input box is managed by the UI. The
    // adapter already removed the matching internal entry, but the UI state
    // is still showing it until we tell it to drop the last entry.
    this.config.ui.onRemoveLastPendingMessage?.();

    return result.text;
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

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
      this.#beginTurn('retryLastToolOutput');

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
      this.#endTurn();
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
    this.#directlyAppendedMessageIds.clear();

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

    // When no turn is in flight, append the user message directly to the
    // message list. The queue observer will still fire when the turn starts,
    // but the dedup guard in moveQueuedMessageIntoList will swallow the
    // second append. When a turn is already in flight, show the message
    // above the input box until the queue actually starts processing it; the
    // message list will be updated when the queue pops this turn.
    const hasInflightTurn = this.config.conversationService.isQueueActive?.() ?? false;
    if (hasInflightTurn) {
      // A turn is already in flight. Show the message above the input box
      // until the queue actually starts processing it; the message list will
      // be updated when the queue pops this turn.
      this.config.ui.onQueuedMessagePending?.(userMessage.id, userMessage.text);
    } else {
      // No turn is in flight — append directly. The queue observer will also
      // fire when the turn starts, but the dedup guard in
      // moveQueuedMessageIntoList prevents a double-append.
      this.config.messages.appendMessages([userMessage]);
      this.#directlyAppendedMessageIds.add(userMessage.id);
    }
    this.config.logWriter?.append({ type: 'user_message', message: userMessage });

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
      this.#beginTurn('sendUserMessage');

    try {
      const turnToSend = turn.skill ? injectSkillIntoTurn(turn) : turn;
      const result = await this.config.conversationService.sendMessage(turnToSend, {
        onEvent: this.createOnEventHandler(applyConversationEvent),
        bypassInputSurgeGuard: options?.bypassInputSurgeGuard,
        preferredMessageId: userMessage.id,
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
      this.#endTurn();
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
      this.#endTurn();
      return;
    }

    if (isMaxTurnsPrompt && answer === 'y') {
      const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
        this.#beginTurn('maxTurnsContinuation');

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
        this.#endTurn();
      }

      return;
    }

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
      this.#beginTurn('approvalDecision');

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
      this.#endTurn();
    }
  }

  /** Open a turn this orchestrator owns, and its streaming session. */
  #beginTurn(label: string) {
    this.#activeTurns += 1;
    this.config.ui.onTurnStart();
    return this.createTurnSession(label);
  }

  /**
   * Close a turn this orchestrator owns. `flushNotifications` is false only for
   * the background-notification turn itself, which decides for itself whether
   * another delivery attempt is safe.
   */
  #endTurn(flushNotifications = true): void {
    this.#activeTurns = Math.max(0, this.#activeTurns - 1);
    this.config.ui.onTurnEnd();
    if (flushNotifications) {
      void this.#deliverBackgroundSubagentNotifications();
    }
  }

  /**
   * Hand every settled background subagent run to the main agent as one
   * system-initiated turn. Does nothing unless the conversation is idle: a
   * running turn or a pending approval owns the agent, and the store keeps the
   * notifications until the next terminal state re-attempts delivery.
   */
  async #deliverBackgroundSubagentNotifications(): Promise<void> {
    const pending = this.config.conversationService.backgroundSubagentNotifications;
    if (!pending || pending.pendingCount === 0) return;
    if (this.#stoppingByUser) return;
    if (this.#activeTurns > 0 || this.pendingApproval) return;
    if (this.config.conversationService.isQueueActive?.()) return;

    const notifications = pending.drain();
    if (notifications.length === 0) return;

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } = this.#beginTurn(
      'backgroundSubagentNotification',
    );

    let delivered = false;
    try {
      const result = await this.config.conversationService.sendMessage(
        formatBackgroundSubagentNotifications(notifications),
        { onEvent: this.createOnEventHandler(applyConversationEvent) },
      );

      // A turn the queue refused to admit resolves without a terminal, so the
      // notifications were never seen and must go back on the queue.
      delivered = Boolean(result);
      applyConversationEvent({ type: 'final', finalText: '' } as any);
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
    } catch (error) {
      this.logError('Error delivering background subagent notifications', error);

      if (isAbortLikeError(error)) {
        this.config.loggingService.debug('Suppressing abort error in background subagent notification turn');
        return;
      }

      this.appendBotError(enhanceApiKeyError(describeError(error)));
      this.config.ui.onApprovalResolved();
    } finally {
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      if (!delivered) {
        pending.retain(notifications);
      }
      // Only a delivered batch may chain: retrying a failed batch immediately
      // would spin. Anything still queued waits for the next turn or completion.
      this.#endTurn(delivered);
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

  /**
   * Append a previously-queued user message into the message list. Called by
   * the queue when it actually starts processing the next turn. After the
   * append, the pending indicator above the input box is cleared.
   */
  private moveQueuedMessageIntoList(messageId: string, fallbackInput?: string | UserTurn): boolean {
    // If the message was already appended directly (when no turn was in flight),
    // the queue observer fired after the fact — skip the duplicate append and
    // avoid restarting its UI lifecycle. Still emit message-started so stale
    // pending UI state cannot survive a queue-state race.
    const wasAlreadyStarted = this.#directlyAppendedMessageIds.has(messageId);
    if (wasAlreadyStarted) {
      this.#directlyAppendedMessageIds.delete(messageId);
    }

    // The message id we created up-front matches the one we will append now.
    // We do not look it up by id because by the time the queue fires the
    // observer the original UserMessage may not be reachable, so we re-build
    // a minimal one with the same id and the formatted text.
    let resolved: UserMessage | null = null;

    if (fallbackInput !== undefined) {
      const turn = normalizeUserTurn(fallbackInput);
      if (hasUserTurnContent(turn)) {
        resolved = {
          id: messageId,
          sender: 'user',
          text: formatUserTurnForDisplay(turn),
          ...(turn.skill ? { skill: turn.skill } : {}),
        };
      }
    }

    if (resolved && !wasAlreadyStarted) {
      this.config.messages.appendMessages([resolved]);
    }

    this.config.ui.onQueuedMessageStarted?.(messageId);
    return wasAlreadyStarted;
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
