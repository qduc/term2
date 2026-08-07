import { describeError, isAbortLikeError } from '../../utils/error-helpers.js';
import { ASK_USER_DECLINE_RESULT } from '../../tools/agent/ask-user-constants.js';
import { createMessageIdFactory } from '../../utils/message-id-factory.js';
import type { ConversationOrchestratorConfig, AskUserAnswer } from './conversation-orchestrator.types.js';
import type { ConversationEvent } from './conversation-events.js';
import type { SubmissionMutation } from './conversation-adapter.js';
import type { BotMessage, CommandMessage, UserMessage } from '../../types/message.js';
import { isUserMessage } from '../../types/message.js';
import type { ConversationTerminal, PendingApproval } from '../../contracts/conversation.js';
import { isDeniedReadApproveAnswer } from '../../contracts/conversation.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { SessionCostSummary } from '../cost/model-cost.js';
import { createStreamingSession } from '../../utils/streaming/streaming-session-factory.js';
import type { StreamingState } from '../../utils/conversation/conversation-utils.js';
import { enhanceApiKeyError, isMaxTurnsError } from '../../utils/conversation/conversation-utils.js';
import { clearStreamingBotMessage, computeNextMessages } from '../../utils/conversation/apply-conversation-result.js';
import {
  listUndoableUserMessageIndices,
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
import type {
  BackgroundSubagentNotification,
  BackgroundSubagentNotificationPort,
} from '../subagents/subagent-notification-store.js';

const REASONING_RESPONSE_THROTTLE_MS = 200;

/**
 * Render settled background runs as one instruction to the main agent. Previews
 * are already capped by the notification store, so the full output is offered
 * by reference rather than inlined.
 */
function formatBackgroundSubagentNotifications(notifications: readonly BackgroundSubagentNotification[]): string {
  const completions = notifications.filter(
    (notification): notification is Extract<BackgroundSubagentNotification, { kind: 'completion' }> =>
      notification.kind === 'completion',
  );
  const questions = notifications.filter(
    (notification): notification is Extract<BackgroundSubagentNotification, { kind: 'question' }> =>
      notification.kind === 'question',
  );
  const sections: string[] = [];

  if (completions.length > 0) {
    const noun = completions.length === 1 ? 'run' : 'runs';
    const entries = completions.map((notification) => {
      const lines = [
        `- runId: ${notification.runId} | role: ${notification.role} | status: ${notification.status}`,
        ...(notification.error ? [`  error: ${notification.error}`] : []),
        '  result:',
        notification.formattedResult
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      ];
      return lines.join('\n');
    });
    sections.push(
      [
        `Background subagent ${noun} finished (${completions.length}). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'The full result is inlined above; you do not need to call get_subagent_result. Assess it against the task before you accept it, then continue through the next necessary steps yourself rather than stopping at the fact that a run finished. Tell the user concisely, in your own words, what you concluded — the report is input to your judgement, not a message to relay.',
      ].join('\n'),
    );
  }

  if (questions.length > 0) {
    const entries = questions.map((notification) => {
      const target = notification.name ?? notification.runId;
      return [
        `- messageId: ${notification.messageId} | target: ${target} | runId: ${notification.runId} | role: ${notification.role}`,
        `  question: ${notification.question}`,
      ].join('\n');
    });
    sections.push(
      [
        `Background subagent question${questions.length === 1 ? '' : 's'} pending (${
          questions.length
        }). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'Decide the answer, investigate it yourself, or escalate to the user if needed. To answer a specific waiting subagent, call send_message({ target, reply_to: messageId, message }). The subagent has no direct user channel; an answer resumes only its waiting tool call.',
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

/** The user-facing companion to the model-only background notification instruction. */
function formatBackgroundSubagentNotificationDisplay(notifications: readonly BackgroundSubagentNotification[]): string {
  return notifications
    .map((notification) => {
      if (notification.kind === 'question') {
        const target = notification.name ?? notification.runId;
        return [
          `messageId: ${notification.messageId} | target: ${target} | runId: ${notification.runId} | role: ${notification.role}`,
          `question: ${notification.question}`,
        ].join('\n');
      }
      const lines = [
        `- runId: ${notification.runId} | role: ${notification.role} | status: ${notification.status}`,
        ...(notification.error ? [`  error: ${notification.error}`] : []),
        ...(notification.preview ? [`  preview: ${notification.preview}`] : []),
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

export class ConversationOrchestrator {
  private pendingApproval: PendingApproval | null = null;
  private askUserAnswers: AskUserAnswer[] = [];
  private currentAskUserQuestionIndex = 0;
  private readonly createMessageId: () => string;
  readonly #directlyAppendedMessageIds = new Set<string>();
  readonly #displayedBackgroundNotificationMessageIds = new Set<string>();
  /**
   * Deferred queue submissions register an activator here. The orchestrator does
   * not count them as active turns until the queue actually starts executing
   * them — remove/discard/reject must not require a matching `#endTurn`.
   */
  readonly #deferredTurnActivators = new Map<string, () => void>();
  /**
   * A pending steer retracted through the id-addressed mutation path. The
   * adapter intentionally keeps the shared steer API boolean, so this marker
   * distinguishes a deliberate retraction from an ordinary failed steer.
   */
  readonly #retractedSteerIds = new Set<string>();
  /** Latest user turn for a pending steer edited before admission. */
  readonly #editedSteerTurns = new Map<string, UserTurn>();
  /**
   * Turns this orchestrator currently owns. Count only executions that have
   * actually started (direct submit or queue-start activation), never merely
   * queued awaits.
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
        if (execution.suppressUserMessageDisplay) {
          return;
        }
        // Deferred submissions activate their orchestrator turn here — the only
        // moment a queued await becomes an owned execution.
        const activateDeferred = this.#deferredTurnActivators.get(execution.requestId);
        if (activateDeferred) {
          activateDeferred();
        }
        const wasAlreadyStarted = this.moveQueuedMessageIntoList(execution.requestId, execution.input);
        if (!wasAlreadyStarted && !activateDeferred) {
          // Recovered or test-only starts without a deferred activator still need
          // the processing indicator when the message enters the transcript.
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

  getCostSummary(): SessionCostSummary | null {
    return this.config.costAccumulator?.getSummary() ?? null;
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
    this.config.costAccumulator?.reset();
    this.#directlyAppendedMessageIds.clear();
    this.#displayedBackgroundNotificationMessageIds.clear();
    this.#retractedSteerIds.clear();
    this.#editedSteerTurns.clear();
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
      this.#displayedBackgroundNotificationMessageIds.clear();
      this.#retractedSteerIds.clear();
      this.#editedSteerTurns.clear();
      this.config.conversationService.backgroundSubagentNotifications?.drain();
    } finally {
      this.#stoppingByUser = false;
    }
  }

  /**
   * Rewind the conversation to a 1-based user turn number, discarding that turn
   * and everything after it, and return the turn's content so the caller can
   * either restore it for editing or resend it. Returns null when the turn
   * number does not identify an undoable turn.
   *
   * This is the single rewind path: `/rewind`, `/undo`, and `/retry` all land
   * here, which is what keeps their reset behavior identical.
   */
  rewindToTurn(turnNumber: number): { text: string; images?: UserTurn['images'] } | null {
    const messages = this.config.messages.getMessages();
    const undoableIndices = listUndoableUserMessageIndices(messages);
    if (turnNumber < 1 || turnNumber > undoableIndices.length) {
      return null;
    }

    const uiIndex = undoableIndices[turnNumber - 1]!;
    const undoCount = undoableIndices.length - (turnNumber - 1);

    const selectedMessage = messages[uiIndex];
    const uiText = isUserMessage(selectedMessage) ? selectedMessage.text : '';

    this.config.conversationService.abort();
    const removed = this.config.conversationService.undoNUserTurns(undoCount);
    const restored = removed ?? { text: uiText };

    this.config.messages.setMessages((prev) => prev.slice(0, uiIndex));
    this.config.approvedContext.current = null;
    this.pendingApproval = null;
    this.resetAskUserState();
    this.config.ui.onResetTransient();
    this.#directlyAppendedMessageIds.clear();
    this.#displayedBackgroundNotificationMessageIds.clear();

    return restored;
  }

  /**
   * Number of user turns the conversation can currently be rewound to. Callers
   * use this to resolve `last` without knowing the turn numbering.
   */
  countRewindableTurns(): number {
    return listUndoableUserMessageIndices(this.config.messages.getMessages()).length;
  }

  async retractPendingSubmission(id: string): Promise<SubmissionMutation> {
    const service = this.config.conversationService;
    if (typeof service.retractSubmission !== 'function') return { kind: 'unknown_id' };

    const result = await service.retractSubmission(id);
    if (result.kind === 'applied') {
      if (result.stage === 'pending_steer') {
        this.#retractedSteerIds.add(id);
        this.#editedSteerTurns.delete(id);
      }
      this.config.ui.onQueuedMessageRemoved?.(id);
    }
    return result;
  }

  async editPendingSubmission(id: string, turn: UserTurn): Promise<SubmissionMutation> {
    const service = this.config.conversationService;
    if (typeof service.editSubmission !== 'function') return { kind: 'unknown_id' };

    const result = await service.editSubmission(id, turn);
    if (result.kind === 'applied') {
      if (result.stage === 'pending_steer') {
        this.#editedSteerTurns.set(id, structuredClone(normalizeUserTurn(turn)));
      }
      this.config.ui.onQueuedMessageEdited?.(id, formatUserTurnForDisplay(normalizeUserTurn(turn)));
    }
    return result;
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

      applyConversationEvent({ type: 'final', finalText: '' });
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

  async sendUserMessage(
    input: string | UserTurn,
    options?: { bypassInputSurgeGuard?: boolean; busyMode?: 'steer' | 'follow_up' },
  ): Promise<void> {
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
    const queueOwnsSubmission =
      this.config.conversationService.isQueueOwningSubmissions?.() ??
      this.config.conversationService.isQueueActive?.() ??
      false;

    // Logged before the branch below, not inside it. "Steer attempt resolved"
    // only exists on the path that actually tries to steer, so a submission
    // that never enters that path — because it arrived without busyMode
    // 'steer', or because the queue did not claim it — is indistinguishable in
    // the logs from one that was never submitted at all. That gap hid a real
    // report of a steer silently queueing: the queue file held the message and
    // the transcript held the user_message, and nothing recorded the decision
    // in between. These four fields name that decision.
    this.config.loggingService.info('Submission routing decided', {
      busyMode: options?.busyMode ?? 'none',
      queueOwnsSubmission,
      queueStateKind: this.config.conversationService.queueStateKind?.() ?? 'unknown',
      canSteer: Boolean(this.config.conversationService.steerActiveTurn),
      messageId: userMessage.id,
    });

    if (queueOwnsSubmission) {
      // A turn is already in flight or the queue is paused with retained work.
      // Show the message above the input box until the queue actually starts
      // processing it; the message list will be updated when the queue pops
      // this turn.
      this.config.ui.onQueuedMessagePending?.(userMessage.id, userMessage.text);

      // A steer belongs to the turn already running: hand it to that turn so
      // the model reads it at its next request, rather than making the user
      // wait for the whole turn to end. The message joins the transcript at the
      // moment the turn takes it, which is when the model actually sees it.
      if (options?.busyMode === 'steer' && this.config.conversationService.steerActiveTurn) {
        // Diagnostics for "my steer just queued". The three fields below
        // separate the ways delivery can fail, which otherwise look identical
        // in the UI because the queued label is drawn before this even runs:
        //   queueActive=false            → refused by the adapter's predicate;
        //     the queue owns the submission but is not in a state that offers
        //     steering (awaiting_preflight, paused, idle with retained work).
        //   queueActive=true, waited≈0ms → refused synchronously downstream:
        //     awaiting an approval, or no run in flight at the run loop.
        //   queueActive=true, waited>0ms → held as pending and released when
        //     the run ended: the turn never reached another request boundary.
        //   steered=true                 → admitted; waitedMs is how long the
        //     user waited for the turn to reach that boundary.
        const queueActive = this.config.conversationService.isQueueActive?.() ?? false;
        const queueStateKind = this.config.conversationService.queueStateKind?.() ?? 'unknown';
        const steerStartedAt = Date.now();
        const steered = await this.config.conversationService
          .steerActiveTurn(turn, { id: userMessage.id })
          .catch((error) => {
            this.logError('Error steering the active turn', error);
            return false;
          });
        this.config.loggingService.info('Steer attempt resolved', {
          steered,
          queueActive,
          queueStateKind,
          waitedMs: Date.now() - steerStartedAt,
          messageId: userMessage.id,
        });
        if (steered) {
          const admittedTurn = this.#editedSteerTurns.get(userMessage.id) ?? turn;
          this.#editedSteerTurns.delete(userMessage.id);
          const { skill: _originalSkill, ...messageWithoutSkill } = userMessage;
          const admittedMessage: UserMessage = {
            ...messageWithoutSkill,
            text: formatUserTurnForDisplay(admittedTurn),
            ...(admittedTurn.skill ? { skill: admittedTurn.skill } : {}),
          };
          this.config.ui.onQueuedMessageStarted?.(userMessage.id);
          this.config.messages.appendMessages([admittedMessage]);
          this.config.logWriter?.append({ type: 'user_message', message: { ...admittedMessage } });
          return;
        }
        if (this.#retractedSteerIds.delete(userMessage.id)) {
          this.#editedSteerTurns.delete(userMessage.id);
          return;
        }
        this.#editedSteerTurns.delete(userMessage.id);
      }
    } else {
      // No turn is in flight — append directly. The queue observer will also
      // fire when the turn starts, but the dedup guard in
      // moveQueuedMessageIntoList prevents a double-append.
      this.config.messages.appendMessages([userMessage]);
      this.#directlyAppendedMessageIds.add(userMessage.id);
    }
    this.config.logWriter?.append({ type: 'user_message', message: { ...userMessage } });

    // Streaming callbacks are bound at submit time, but deferred submissions
    // must not count as active turns until the queue starts them. Otherwise
    // remove/discard would need a matching endTurn for work that never ran.
    let turnActivated = !queueOwnsSubmission;
    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } = queueOwnsSubmission
      ? this.createTurnSession('sendUserMessage')
      : this.#beginTurn('sendUserMessage');

    if (queueOwnsSubmission) {
      this.#deferredTurnActivators.set(userMessage.id, () => {
        if (turnActivated) return;
        turnActivated = true;
        this.#activeTurns += 1;
        this.config.ui.onTurnStart();
      });
    }

    try {
      const turnToSend = turn.skill ? injectSkillIntoTurn(turn) : turn;
      const result = await this.config.conversationService.sendMessage(turnToSend, {
        onEvent: this.createOnEventHandler(applyConversationEvent),
        bypassInputSurgeGuard: options?.bypassInputSurgeGuard,
        busyMode: options?.busyMode,
        preferredMessageId: userMessage.id,
      });

      applyConversationEvent({ type: 'final', finalText: '' });
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
    } catch (error) {
      this.logError('Error in sendUserMessage', error);

      if (queueOwnsSubmission) {
        this.config.ui.onQueuedMessageRemoved?.(userMessage.id);
      }

      if (isAbortLikeError(error)) {
        this.config.loggingService.debug('Suppressing abort error in sendUserMessage');
        return;
      }

      // A submission that never left the pending queue produced no turn to
      // report on, but it also produced no answer: the pending indicator has
      // just been cleared, so saying nothing would make the user's text vanish
      // without explanation. Report the rejection and hand the text back.
      if (queueOwnsSubmission && !turnActivated) {
        this.appendBotError(
          `${enhanceApiKeyError(describeError(error))}\n\nThis message was not sent: ${userMessage.text}`,
        );
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
      this.#deferredTurnActivators.delete(userMessage.id);
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      if (turnActivated) {
        this.#endTurn();
      }
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

        applyConversationEvent({ type: 'final', finalText: '' });
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
      applyConversationEvent({ type: 'final', finalText: '' });
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
   * Announce settled runs in the transcript, once each.
   *
   * Display is deliberately not tied to the agent receiving them: the user
   * should see a run land the moment it does, whether the report reaches the
   * agent at the next request boundary or waits for a turn of its own.
   */
  #announceBackgroundSubagentNotifications(notifications: readonly BackgroundSubagentNotification[]): void {
    const newlyDisplayed = notifications.filter(
      (notification) => !this.#displayedBackgroundNotificationMessageIds.has(notification.messageId),
    );
    if (newlyDisplayed.length === 0) return;
    for (const notification of newlyDisplayed) {
      this.#displayedBackgroundNotificationMessageIds.add(notification.messageId);
    }
    const runs = newlyDisplayed
      .filter(
        (notification): notification is Extract<BackgroundSubagentNotification, { kind: 'completion' }> =>
          notification.kind === 'completion',
      )
      .map(({ name, role, status, error }) => ({
        ...(name !== undefined ? { name } : {}),
        role,
        status,
        ...(error ? { error } : {}),
      }));
    this.config.messages.appendMessages([
      {
        id: this.createMessageId(),
        sender: 'command',
        status: 'completed',
        command: 'background_subagent_notification',
        output: formatBackgroundSubagentNotificationDisplay(newlyDisplayed),
        success: true,
        toolName: 'background_subagent_notification',
        toolArgs: { runs },
      },
    ]);
  }

  /**
   * Offer settled runs to the turn already in flight.
   *
   * Taken as one report at that turn's next request boundary. If the turn will
   * not take them they go back to the store unchanged, so the idle path still
   * delivers them and the agent never sees the same run twice.
   */
  async #injectBackgroundSubagentNotifications(pending: BackgroundSubagentNotificationPort): Promise<void> {
    if (!this.config.conversationService.injectIntoActiveTurn) return;
    const notifications = pending.drain();
    if (notifications.length === 0) return;

    this.#announceBackgroundSubagentNotifications(notifications);

    const injected = await this.config.conversationService
      .injectIntoActiveTurn([
        { type: 'message', role: 'user', content: formatBackgroundSubagentNotifications(notifications) },
      ])
      .catch((error) => {
        this.logError('Error delivering background subagent notifications', error);
        return false;
      });

    if (!injected) pending.retain(notifications);
  }

  /**
   * Hand every settled background subagent run to the main agent.
   *
   * The agent that launched these runs is usually still working when they
   * settle, so delivery goes into that turn at its next request boundary. Only
   * when no turn will take them does this open one of its own.
   */
  async #deliverBackgroundSubagentNotifications(): Promise<void> {
    const pending = this.config.conversationService.backgroundSubagentNotifications;
    if (!pending || pending.pendingCount === 0) return;
    if (this.#stoppingByUser) return;

    const turnIsRunning = this.#activeTurns > 0 || this.config.conversationService.isQueueActive?.() === true;
    if (turnIsRunning) {
      await this.#injectBackgroundSubagentNotifications(pending);
      return;
    }
    if (this.pendingApproval) return;

    const notifications = pending.drain();
    if (notifications.length === 0) return;

    this.#announceBackgroundSubagentNotifications(notifications);

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } = this.#beginTurn(
      'backgroundSubagentNotification',
    );

    let delivered = false;
    try {
      const result = await this.config.conversationService.sendMessage(
        formatBackgroundSubagentNotifications(notifications),
        {
          onEvent: this.createOnEventHandler(applyConversationEvent),
          suppressUserMessageDisplay: true,
        },
      );

      // A turn the queue refused to admit resolves without a terminal, so the
      // notifications were never seen and must go back on the queue.
      delivered = Boolean(result);
      applyConversationEvent({ type: 'final', finalText: '' });
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

  private createOnEventHandler(baseOnEvent: (event: ConversationEvent) => void): (event: ConversationEvent) => void {
    return (event: ConversationEvent) => {
      const eventType = event.type;
      if (eventType === 'reasoning_delta') {
        this.config.ui.onStreamingThinkingStarted((this.config.now ?? Date.now)());
      } else if (this.clearsThinkingIndicator(eventType)) {
        this.config.ui.onStreamingThinkingCleared();
      }

      if (eventType === 'tool_call_streaming_delta') {
        this.config.ui.onStreamingToolInfo({ toolName: event.toolName, argumentCharCount: event.argumentCharCount });
      } else if (eventType === 'tool_started' || eventType === 'text_delta' || eventType === 'final') {
        this.config.ui.onStreamingToolInfo(null);
      }

      if (eventType === 'user_message_consumed_for_abort') {
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
      if (eventType === 'subagent_completed') {
        if (event.result.usage) {
          this.config.subagentUsageAccumulator?.add(event.result.usage);
        }
        this.config.costAccumulator?.addRecords(event.result.costRecords ?? []);
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
      this.config.ui.onApprovalRequested({ ...result.approval, llmAdvisory: result.approval.llmAdvisory });
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
    this.config.costAccumulator?.addRecords(result.costRecords ?? []);
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
