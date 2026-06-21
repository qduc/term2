import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import { describeError, isAbortLikeError } from '../utils/error-helpers.js';
import { ASK_USER_DECLINE_RESULT } from '../tools/agent/ask-user-constants.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { createMessageId } from './message-id.js';
import { countUndoableUserTurnsFrom, findLastUndoableUserMessage } from '../utils/conversation/message-utils.js';
import { clearStreamingBotMessage, computeNextMessages } from '../utils/conversation/apply-conversation-result.js';
import { useConversationMessages } from './use-conversation-messages.js';
import { useConversationSettings } from './use-conversation-settings.js';
import { enhanceApiKeyError, isMaxTurnsError } from '../utils/conversation/conversation-utils.js';
import type { StreamingState } from '../utils/conversation/conversation-utils.js';
import { createStreamingSession } from '../utils/streaming/streaming-session-factory.js';
import type { BotMessage, CommandMessage, Message, UserMessage } from '../types/message.js';
import { isBotMessage, isUserMessage } from '../types/message.js';
import type { NormalizedUsage, UsageAccumulator } from '../utils/ai/token-usage.js';
import type { ConversationTerminal } from '../contracts/conversation.js';
import { useSetting } from './use-setting.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import {
  annotateApprovedCommandMessage,
  filterPendingCommandMessagesForApproval,
  type ApprovedToolContext,
} from '../services/approval/approval-presentation-policy.js';
import {
  formatUserTurnForDisplay,
  hasUserTurnContent,
  injectSkillIntoTurn,
  normalizeUserTurn,
  type UserTurn,
} from '../types/user-turn.js';
import { conversationUIReducer, createInitialUIState, getConversationUIFlags } from './conversation-ui-reducer.js';

export type {
  BotMessage,
  CommandMessage,
  Message,
  ReasoningMessage,
  SubagentActivityMessage,
  SystemMessage,
  UserMessage,
} from '../types/message.js';

const REASONING_RESPONSE_THROTTLE_MS = 200;
const MAX_MESSAGE_COUNT = 300;

const clearsThinkingIndicator = (eventType: string): boolean =>
  eventType === 'text_delta' ||
  eventType === 'tool_started' ||
  eventType === 'tool_call_streaming_delta' ||
  eventType === 'final';

const getInitialLastUsage = (messages: Message[]): NormalizedUsage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isBotMessage(message)) {
      continue;
    }
    const usage = message.usage;
    if (usage && Object.keys(usage).length > 0) {
      return usage;
    }
  }
  return null;
};

const dummySettingsService = {
  get: () => 'openai',
  onChange: () => () => {},
} as any;

export interface ConversationNotifier {
  approvalNeeded(): void;
  turnComplete(): void;
}

export const useConversation = ({
  conversationService,
  loggingService,
  usageAccumulator,
  subagentUsageAccumulator,
  initialMessages = [],
  sessionId,
  onClear,
  settingsService,
  onRestoreInput,
  logWriter,
  notifier,
}: {
  conversationService: ConversationService;
  loggingService: ILoggingService;
  usageAccumulator?: UsageAccumulator;
  subagentUsageAccumulator?: UsageAccumulator;
  initialMessages?: Message[];
  sessionId?: string;
  onClear?: () => void | Promise<void>;
  settingsService?: SettingsService;
  /**
   * Called when a user message could not be sent (e.g. upstream error before any
   * stream tokens, or input-surge guard) and the session dropped it from the
   * conversation store. The UI removes the trailing user message and forwards
   * the original text here so the caller can repopulate the input box.
   */
  onRestoreInput?: (text: string) => void;
  logWriter?: { append: (event: any) => void };
  /** Optional notifier to fire desktop notifications on approval/completion events. */
  notifier?: ConversationNotifier;
}) => {
  const { messages, setMessages, trimMessages, appendMessages, addSystemMessage, addShellMessage, getUserMessages } =
    useConversationMessages({
      initialMessages,
      maxMessageCount: MAX_MESSAGE_COUNT,
    });

  const { setModel, setReasoningEffort, setTemperature } = useConversationSettings({
    conversationService,
  });

  const [uiState, dispatch] = useReducer(conversationUIReducer, initialMessages, (init) =>
    createInitialUIState(getInitialLastUsage(init)),
  );
  const { thinkingStartedAt, toolCallStreamingInfo, lastUsage, lastCodexRateLimit } = uiState;
  const {
    isProcessing,
    waitingForApproval,
    waitingForRejectionReason,
    waitingForAskUserAnswer,
    askUserAnswers,
    currentAskUserQuestionIndex,
    pendingApproval,
  } = getConversationUIFlags(uiState);
  const approvedContextRef = useRef<ApprovedToolContext | null>(null);

  // Use a ref to keep askUserAnswers current for the handleApprovalDecision callback
  // This fixes the stale closure bug in multi-question ask_user flows
  const askUserAnswersRef = useRef(askUserAnswers);
  useEffect(() => {
    askUserAnswersRef.current = askUserAnswers;
  }, [askUserAnswers]);

  const provider = useSetting<string>(settingsService || dummySettingsService, 'agent.provider') ?? 'openai';

  useEffect(() => {
    dispatch({ type: 'rate_limit/cleared' });
  }, [provider]);

  const annotateCommandMessage = useCallback((cmdMsg: CommandMessage): CommandMessage => {
    const approvedMessage = annotateApprovedCommandMessage(cmdMsg, approvedContextRef.current);
    const matchedByToolName =
      approvedMessage !== cmdMsg &&
      !approvedContextRef.current?.callId &&
      Boolean(approvedContextRef.current?.toolName) &&
      approvedContextRef.current?.toolName === cmdMsg.toolName;

    if (matchedByToolName) {
      approvedContextRef.current = null;
    }

    return approvedMessage;
  }, []);

  const createOnEventWithSubagentTracking = useCallback(
    (baseOnEvent: (event: any) => void) => {
      return (event: any) => {
        const eventType = typeof event?.type === 'string' ? event.type : undefined;
        if (eventType === 'reasoning_delta') {
          dispatch({ type: 'streaming/thinking_started', timestamp: Date.now() });
        } else if (eventType && clearsThinkingIndicator(eventType)) {
          dispatch({ type: 'streaming/thinking_cleared' });
        }

        if (eventType === 'tool_call_streaming_delta') {
          dispatch({
            type: 'streaming/tool_info',
            info: { toolName: event.toolName, argumentCharCount: event.argumentCharCount },
          });
        } else if (eventType === 'tool_started' || eventType === 'text_delta' || eventType === 'final') {
          dispatch({ type: 'streaming/tool_info', info: null });
        }

        baseOnEvent(event);
        if (subagentUsageAccumulator && event?.type === 'subagent_completed' && event?.result?.usage) {
          subagentUsageAccumulator.add(event.result.usage);
        }
      };
    },
    [subagentUsageAccumulator],
  );

  const applyServiceResult = useCallback(
    (
      result: ConversationTerminal | null,
      streamingState: StreamingState,
      latestStreamedUsage?: NormalizedUsage | null,
    ) => {
      if (!result) {
        return;
      }

      if (result.type === 'approval_required') {
        if (result.usage) {
          // result.usage here is the run-cumulative usage *so far* for a run
          // that is still in progress (paused for approval). The terminal
          // `response` result will carry the full run-cumulative usage once
          // the run completes, so accumulating here would double-count the
          // pre-approval turns. Only update the live footer.
          dispatch({ type: 'usage/updated', usage: latestStreamedUsage ?? result.usage });
        }
        // Don't also show the transient pending/running command message.
        setMessages((prev) => trimMessages(filterPendingCommandMessagesForApproval(prev, result.approval)));
        dispatch({
          type: 'approval/requested',
          approval: { ...result.approval, llmAdvisory: (result.approval as any).llmAdvisory },
        });
        notifier?.approvalNeeded();
        return;
      }

      // Apply the response result via the pure helper. The helper finalizes
      // the live streaming bot message in place when one exists, instead of
      // appending a duplicate finalized copy. This prevents the assistant's
      // reply from rendering twice when streaming text never crossed a safe
      // markdown boundary.
      setMessages(
        (prev) =>
          computeNextMessages({
            prev,
            result,
            streamingState,
            createMessageId,
            trimMessages,
            annotateCommandMessage,
          }).next,
      );
      if (result.type === 'response' && streamingState.currentBotMessageId !== null) {
        clearStreamingBotMessage(streamingState);
      }
      dispatch({ type: 'approval/resolved' });
      notifier?.turnComplete();
      if (result.usage) {
        usageAccumulator?.add(result.usage);
        dispatch({ type: 'usage/updated', usage: latestStreamedUsage ?? result.usage });
      }
    },
    [annotateCommandMessage, trimMessages, usageAccumulator, notifier, setMessages],
  );

  const createTurnSession = useCallback(
    (label: string) =>
      createStreamingSession(
        {
          appendMessages,
          setMessages,
          trimMessages,
          annotateCommandMessage,
          loggingService,
          setLastUsage: (usage) => dispatch({ type: 'usage/updated', usage }),
          setCodexRateLimit: (rateLimit) => dispatch({ type: 'rate_limit/updated', rateLimit }),
          reasoningThrottleMs: REASONING_RESPONSE_THROTTLE_MS,
        },
        label,
      ),
    [appendMessages, setMessages, trimMessages, annotateCommandMessage, loggingService],
  );

  const sendUserMessage = useCallback(
    async (input: string | UserTurn, options?: { bypassInputSurgeGuard?: boolean }) => {
      const turn = normalizeUserTurn(input);
      if (!hasUserTurnContent(turn)) {
        return;
      }

      const userMessage: UserMessage = {
        id: createMessageId(),
        sender: 'user',
        text: formatUserTurnForDisplay(turn),
        ...(turn.skill ? { skill: turn.skill } : {}),
      };
      appendMessages([userMessage]);
      logWriter?.append({ type: 'user_message', message: userMessage });
      dispatch({ type: 'turn/started' });

      const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
        createTurnSession('sendUserMessage');

      const wrappedOnEvent = (event: any) => {
        if (event?.type === 'user_message_consumed_for_abort') {
          setMessages((prev) => {
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
        applyConversationEvent(event);
      };

      try {
        // Inject skill content into the turn text before sending to AI
        const turnToSend = turn.skill ? injectSkillIntoTurn(turn) : turn;
        const result = await conversationService.sendMessage(turnToSend, {
          onEvent: createOnEventWithSubagentTracking(wrappedOnEvent),
          bypassInputSurgeGuard: options?.bypassInputSurgeGuard,
        });

        applyConversationEvent({ type: 'final', finalText: '' } as any);
        // Flush any throttled bot update so the streaming message reflects the
        // last delta before we decide whether to finalize it in place.
        botResponseUpdater.flush();
        applyServiceResult(result, streamingState, streamingState.latestUsage);
      } catch (error) {
        loggingService.error('Error in sendUserMessage', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          ...(error instanceof Error && (error as any).eventKind ? { eventKind: (error as any).eventKind } : {}),
        });

        // Don't show error messages for user-initiated aborts
        if (isAbortLikeError(error)) {
          loggingService.debug('Suppressing abort error in sendUserMessage');
          // The finally block will handle cleanup
          return;
        }

        const rawErrorMessage = describeError(error);
        const errorMessage = enhanceApiKeyError(rawErrorMessage);

        // If the session dropped the user turn from the store as part of this
        // error, mirror that in the UI: remove the trailing user message and
        // restore its text to the input box for editing/retry.
        const dropped = (error as any)?.rawEvent?.droppedUserMessage as
          | { text: string; imageCount: number }
          | undefined;
        if (dropped) {
          setMessages((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].sender === 'user') {
                return prev.slice(0, i);
              }
            }
            return prev;
          });
          onRestoreInput?.(dropped.text);
        }

        if (isMaxTurnsError(errorMessage)) {
          // Create an approval prompt for max turns continuation
          dispatch({
            type: 'approval/requested',
            approval: {
              agentName: 'System',
              toolName: 'max_turns_exceeded',
              argumentsText: errorMessage,
              rawInterruption: null,
              isMaxTurnsPrompt: true,
            },
          });
        } else {
          // For other errors, just show the error message
          const botErrorMessage: BotMessage = {
            id: createMessageId(),
            sender: 'bot',
            status: 'finalized',
            text: `Error: ${errorMessage}`,
          };
          appendMessages([botErrorMessage]);
          // Reset approval state on error to allow user to continue
          dispatch({ type: 'approval/resolved' });
        }
      } finally {
        loggingService.debug('sendUserMessage finally block - resetting state');
        // flushLog();
        reasoningUpdater.flush();
        botResponseUpdater.cancel();
        dispatch({ type: 'turn/completed' });
        // Don't reset waitingForApproval here - it's set by applyServiceResult
        // and should only be cleared by handleApprovalDecision or stopProcessing
      }
    },
    [
      conversationService,
      applyServiceResult,
      appendMessages,
      loggingService,
      createOnEventWithSubagentTracking,
      onRestoreInput,
      createTurnSession,
      logWriter,
      setMessages,
    ],
  );

  const handleApprovalDecision = useCallback(
    async (answer: string, rejectionReason?: string, approvalAnswer?: string) => {
      if (!waitingForApproval || !pendingApproval) {
        return;
      }

      // Check if this is a max turns exceeded prompt
      const isMaxTurnsPrompt = pendingApproval.isMaxTurnsPrompt;
      const isAskUser = pendingApproval.toolName === 'ask_user';

      if (isAskUser && answer === 'y' && approvalAnswer !== ASK_USER_DECLINE_RESULT) {
        // Parse questions
        let questions: any[] = [];
        try {
          const parsed = JSON.parse(pendingApproval.argumentsText);
          questions = parsed.questions || [];
        } catch {
          // noop
        }

        // Only JSON-parse multi-select arrays; single-select answers are plain strings
        let parsedAns: any = approvalAnswer ?? '';
        const currentQuestion = questions[askUserAnswersRef.current.length];
        if (currentQuestion?.is_multi_select) {
          try {
            const maybeArray = JSON.parse(approvalAnswer ?? '');
            if (Array.isArray(maybeArray)) {
              parsedAns = maybeArray;
            }
          } catch {
            // Not JSON — keep as plain string
          }
        }

        const nextAnswers = [...askUserAnswersRef.current, parsedAns];

        if (nextAnswers.length < questions.length) {
          // More questions to answer!
          dispatch({ type: 'ask_user/answer_submitted', answer: parsedAns });
          dispatch({ type: 'ask_user/advance_to_next', nextIndex: nextAnswers.length });
          return;
        }

        // All questions answered — dispatch final answer to complete the ask_user sequence
        dispatch({ type: 'ask_user/answer_submitted', answer: parsedAns });
        approvalAnswer = JSON.stringify(nextAnswers);
      }

      if (answer === 'y') {
        approvedContextRef.current = {
          callId: pendingApproval.callId,
          toolName: pendingApproval.toolName,
        };
      }

      dispatch({ type: 'approval/resolved' });

      // Handle "n" answer for max turns - return to input
      if (isMaxTurnsPrompt && answer === 'n') {
        dispatch({ type: 'turn/completed' });
        return;
      }

      // Handle "y" answer for max turns - continue execution automatically
      if (isMaxTurnsPrompt && answer === 'y') {
        dispatch({ type: 'turn/started' });

        const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
          createTurnSession('maxTurnsContinuation');

        try {
          // Send a continuation message to resume work
          const continuationMessage = 'Please continue with your previous task.';
          const result = await conversationService.sendMessage(continuationMessage, {
            onEvent: createOnEventWithSubagentTracking(applyConversationEvent),
          });

          applyConversationEvent({ type: 'final', finalText: '' } as any);
          applyServiceResult(result, streamingState, streamingState.latestUsage);
        } catch (error) {
          loggingService.error('Error in continuation after max turns', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });

          // Don't show error messages for user-initiated aborts
          if (isAbortLikeError(error)) {
            loggingService.debug('Suppressing abort error in max turns continuation');
            // The finally block will handle cleanup
            return;
          }

          const errorMessage = error instanceof Error ? error.message : String(error);
          const botErrorMessage: BotMessage = {
            id: createMessageId(),
            sender: 'bot',
            status: 'finalized',
            text: `Error: ${errorMessage}`,
          };
          appendMessages([botErrorMessage]);
          dispatch({ type: 'approval/resolved' });
        } finally {
          // flushLog();
          reasoningUpdater.flush();
          botResponseUpdater.cancel();
          dispatch({ type: 'turn/completed' });
        }
        return;
      }

      dispatch({ type: 'turn/started' });
      const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
        createTurnSession('approvalDecision');

      try {
        const result = await conversationService.handleApprovalDecision(answer, rejectionReason, {
          onEvent: createOnEventWithSubagentTracking(applyConversationEvent),
          approvalAnswer,
        });
        applyConversationEvent({ type: 'final', finalText: '' } as any);
        // Flush any throttled bot update so the streaming message reflects the
        // last delta before we decide whether to finalize it in place.
        botResponseUpdater.flush();
        applyServiceResult(result, streamingState, streamingState.latestUsage);
      } catch (error) {
        loggingService.error('Error in handleApprovalDecision', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Don't show error messages for user-initiated aborts
        if (isAbortLikeError(error)) {
          loggingService.debug('Suppressing abort error in handleApprovalDecision');
          // The finally block will handle cleanup
          return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        const botErrorMessage: BotMessage = {
          id: createMessageId(),
          sender: 'bot',
          status: 'finalized',
          text: `Error: ${errorMessage}`,
        };
        appendMessages([botErrorMessage]);
        // Reset approval state on error to allow user to continue
        dispatch({ type: 'approval/resolved' });
      } finally {
        loggingService.debug('handleApprovalDecision finally block - resetting state');
        reasoningUpdater.flush();
        botResponseUpdater.cancel();
        dispatch({ type: 'turn/completed' });
        // Don't reset approval state here - if the result is another approval_required,
        // applyServiceResult will set waitingForApproval=true, but this finally block
        // would immediately clear it, causing the input box to reappear
      }
    },
    [
      applyServiceResult,
      conversationService,
      waitingForApproval,
      pendingApproval,
      appendMessages,
      loggingService,
      createOnEventWithSubagentTracking,
      createTurnSession,
    ],
  );

  const onTypeAnswer = useCallback(() => {
    dispatch({ type: 'ask_user/set_waiting' });
  }, []);

  const clearConversation = useCallback(async () => {
    if (onClear) {
      await onClear();
    } else {
      conversationService.resetWithNewId(crypto.randomUUID());
    }
    setMessages([]);
    approvedContextRef.current = null;
    dispatch({ type: 'reset_all' });
    usageAccumulator?.reset();
    subagentUsageAccumulator?.reset();
  }, [conversationService, usageAccumulator, subagentUsageAccumulator, onClear, setMessages]);

  const stopProcessing = useCallback(() => {
    conversationService.abort();
    approvedContextRef.current = null;
    dispatch({ type: 'reset_transient' });
  }, [conversationService]);

  const undoLastUserMessage = useCallback((): { text: string; images?: UserTurn['images'] } | null => {
    const lastUserIndex = findLastUndoableUserMessage(messages);
    if (lastUserIndex === -1) {
      return null;
    }

    const lastUserMessage = messages[lastUserIndex];
    const uiText = isUserMessage(lastUserMessage) ? lastUserMessage.text : '';
    conversationService.abort();
    const removed = conversationService.undoLastUserTurn();
    const restored = removed ?? { text: uiText };
    setMessages((prev) => prev.slice(0, lastUserIndex));
    approvedContextRef.current = null;
    dispatch({ type: 'reset_transient' });

    return restored;
  }, [messages, conversationService, setMessages]);

  const undoToUserMessage = useCallback(
    (uiIndex: number): string | null => {
      // Count how many genuine user turns (excluding abort-consumed messages) are
      // at or after this index — that's what the store needs to roll back.
      const undoCount = countUndoableUserTurnsFrom(messages, uiIndex);

      if (undoCount === 0) return null;

      const selectedMessage = messages[uiIndex];
      const uiText = isUserMessage(selectedMessage) ? selectedMessage.text : '';

      conversationService.abort();
      const removed = conversationService.undoNUserTurns(undoCount);
      const restored = removed?.text ?? uiText;

      setMessages((prev) => prev.slice(0, uiIndex));
      approvedContextRef.current = null;
      dispatch({ type: 'reset_transient' });

      return restored;
    },
    [messages, conversationService, setMessages],
  );

  // Compatibility wrappers for app.tsx — these dispatch domain actions.
  const setWaitingForRejectionReason = useCallback((value: boolean) => {
    dispatch({ type: value ? 'rejection/set_waiting' : 'rejection/cleared' });
  }, []);

  const setWaitingForAskUserAnswer = useCallback((value: boolean) => {
    dispatch({ type: value ? 'ask_user/set_waiting' : 'ask_user/clear_waiting' });
  }, []);

  const goToPreviousQuestion = useCallback(() => {
    if (currentAskUserQuestionIndex > 0) {
      dispatch({
        type: 'ask_user/go_back',
      });
    }
  }, [currentAskUserQuestionIndex]);

  const goToNextQuestion = useCallback(() => {
    dispatch({
      type: 'ask_user/advance_to_next',
      nextIndex: currentAskUserQuestionIndex + 1,
    });
  }, [currentAskUserQuestionIndex]);

  const getSubagentUsage = useCallback(() => subagentUsageAccumulator?.get() ?? null, [subagentUsageAccumulator]);

  return {
    messages,
    sessionId: sessionId ?? conversationService.sessionId,
    lastUsage,
    lastCodexRateLimit,
    pendingApproval,
    waitingForApproval,
    waitingForRejectionReason,
    waitingForAskUserAnswer,
    currentAskUserQuestionIndex,
    setWaitingForRejectionReason,
    setWaitingForAskUserAnswer,
    isProcessing,
    thinkingStartedAt,
    toolCallStreamingInfo,
    sendUserMessage,
    handleApprovalDecision,
    onTypeAnswer,
    clearConversation,
    stopProcessing,
    undoLastUserMessage,
    getUserMessages,
    undoToUserMessage,
    setModel,
    setReasoningEffort,
    setTemperature,
    addSystemMessage,
    addShellMessage,
    getSubagentUsage,
    goToPreviousQuestion,
    goToNextQuestion,
  };
};
