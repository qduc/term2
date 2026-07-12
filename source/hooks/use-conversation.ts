import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { useConversationMessages } from './use-conversation-messages.js';
import { useConversationSettings } from './use-conversation-settings.js';
import type { NormalizedUsage, UsageAccumulator } from '../utils/ai/token-usage.js';
import { useSetting } from './use-setting.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { ConversationOrchestrator } from '../services/conversation/conversation-orchestrator.js';
import {
  normalizeApprovalDecision,
  routeConversationTurnSubmission,
} from '../services/conversation/conversation-input-routing.js';
import type { Message } from '../types/message.js';
import { isBotMessage } from '../types/message.js';
import type { UserTurn } from '../types/user-turn.js';
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

const MAX_MESSAGE_COUNT = 300;

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
  replaceInput,
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
  replaceInput?: (text: string) => void;
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
  const { thinkingStartedAt, toolCallStreamingInfo, lastUsage, lastCodexRateLimit, pendingQueuedMessages } = uiState;
  const {
    isProcessing,
    waitingForApproval,
    waitingForRejectionReason,
    waitingForAskUserAnswer,
    currentAskUserQuestionIndex,
    pendingApproval,
    queueActive,
    queuePaused,
    queueLength,
    queuePauseReason,
  } = getConversationUIFlags(uiState);

  const approvedContextRef = useRef<
    import('../services/approval/approval-presentation-policy.js').ApprovedToolContext | null
  >(null);

  const provider = useSetting<string>(settingsService || dummySettingsService, 'agent.provider') ?? 'openai';

  useEffect(() => {
    dispatch({ type: 'rate_limit/cleared' });
  }, [provider]);

  useEffect(() => {
    if (typeof conversationService.setRetryCallback !== 'function') {
      return;
    }

    conversationService.setRetryCallback(() => addSystemMessage('Retrying due to upstream error...'));
  }, [conversationService, addSystemMessage]);

  // ── Orchestrator instantiation (lazy, once) ─────────────────────────────
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const orchestratorRef = useRef<ConversationOrchestrator | null>(null);
  if (!orchestratorRef.current) {
    orchestratorRef.current = new ConversationOrchestrator({
      conversationService,
      loggingService,
      messages: {
        getMessages: () => messagesRef.current,
        setMessages,
        appendMessages,
        trimMessages,
      },
      ui: {
        onTurnStart: () => dispatch({ type: 'turn/started' }),
        onTurnEnd: () => dispatch({ type: 'turn/completed' }),
        onApprovalRequested: (approval) => dispatch({ type: 'approval/requested', approval }),
        onApprovalResolved: () => dispatch({ type: 'approval/resolved' }),
        onUsageUpdate: (usage) => dispatch({ type: 'usage/updated', usage }),
        onRateLimitUpdate: (rateLimit) => dispatch({ type: 'rate_limit/updated', rateLimit }),
        onRateLimitClear: () => dispatch({ type: 'rate_limit/cleared' }),
        onResetTransient: () => dispatch({ type: 'reset_transient' }),
        onResetAll: () => dispatch({ type: 'reset_all' }),
        onStreamingThinkingStarted: (timestamp) => dispatch({ type: 'streaming/thinking_started', timestamp }),
        onStreamingThinkingCleared: () => dispatch({ type: 'streaming/thinking_cleared' }),
        onStreamingToolInfo: (info) => dispatch({ type: 'streaming/tool_info', info }),
        onAskUserAnswerSubmitted: (answer) => dispatch({ type: 'ask_user/answer_submitted', answer }),
        onAskUserAdvanceToNext: (nextIndex) => dispatch({ type: 'ask_user/advance_to_next', nextIndex }),
        onAskUserGoBack: (_currentIndex, _answers) => dispatch({ type: 'ask_user/go_back' }),
        onQueueStateChange: (snapshot) => dispatch({ type: 'queue/updated', snapshot }),
        onQueuedMessagePending: (id, text) =>
          dispatch({ type: 'queue/message_pending', id, text, queuedAt: Date.now() }),
        onQueuedMessageStarted: (id) => dispatch({ type: 'queue/message_started', id }),
        onRemoveLastPendingMessage: () => dispatch({ type: 'queue/remove_last_pending' }),
      },
      approvedContext: approvedContextRef,
      usageAccumulator,
      subagentUsageAccumulator,
      notifier,
      onRestoreInput,
      onClear,
      logWriter,
    });
  }

  const orchestrator = orchestratorRef.current;

  // Keep mutable config in sync across renders.
  useEffect(() => {
    orchestrator.updateCallbacks({ onRestoreInput, onClear });
  }, [orchestrator, onRestoreInput, onClear]);

  // ── Public API — all orchestration delegates to the orchestrator ─────────
  const sendUserMessage = useCallback(
    (input: string | UserTurn, options?: { bypassInputSurgeGuard?: boolean }) =>
      orchestrator.sendUserMessage(input, options),
    [orchestrator],
  );

  const handleApprovalDecision = useCallback(
    (answer: string, rejectionReason?: string, approvalAnswer?: string) =>
      orchestrator.handleApprovalDecision(answer, rejectionReason, approvalAnswer),
    [orchestrator],
  );

  const clearConversation = useCallback(() => orchestrator.clearConversation(), [orchestrator]);

  const stopProcessing = useCallback(() => orchestrator.stopProcessing(), [orchestrator]);

  const stopProcessingWithNotice = useCallback(() => {
    stopProcessing();
    addSystemMessage('Stopped');
  }, [stopProcessing, addSystemMessage]);

  const undoLastUserMessage = useCallback<() => { text: string; images?: UserTurn['images'] } | null>(
    () => orchestrator.undoLastUserMessage(),
    [orchestrator],
  );

  const retryLastToolOutput = useCallback<() => Promise<boolean>>(
    () => orchestrator.retryLastToolOutput(),
    [orchestrator],
  );

  const undoToUserMessage = useCallback((uiIndex: number) => orchestrator.undoToUserMessage(uiIndex), [orchestrator]);

  const removeLastQueuedPendingMessage = useCallback(
    () => orchestrator.removeLastQueuedPendingMessage(),
    [orchestrator],
  );

  const getSubagentUsage = useCallback(() => orchestrator.getSubagentUsage(), [orchestrator]);

  const goToPreviousQuestion = useCallback(() => orchestrator.goToPreviousQuestion(), [orchestrator]);

  const goToNextQuestion = useCallback(() => orchestrator.goToNextQuestion(), [orchestrator]);

  const submitApprovalDecision = useCallback(
    async (answer?: string) => {
      const normalized = normalizeApprovalDecision(answer);
      if (normalized.approvalAnswer !== undefined) {
        replaceInput?.('');
        await handleApprovalDecision(normalized.answer, undefined, normalized.approvalAnswer);
        return;
      }

      await handleApprovalDecision(normalized.answer);
    },
    [handleApprovalDecision, replaceInput],
  );

  const submitConversationTurn = useCallback(
    async (turn: UserTurn) => {
      const route = routeConversationTurnSubmission({
        text: turn.text,
        waitingForAskUserAnswer,
        waitingForRejectionReason,
        waitingForApproval,
      });

      if (route.kind === 'blocked') {
        return true;
      }

      if (route.kind === 'approval_answer') {
        replaceInput?.('');
        await handleApprovalDecision(route.answer, undefined, route.approvalAnswer);
        return true;
      }

      if (route.kind === 'rejection_reason') {
        replaceInput?.('');
        await handleApprovalDecision('n', route.reason);
        return true;
      }

      return false;
    },
    [handleApprovalDecision, replaceInput, waitingForApproval, waitingForAskUserAnswer, waitingForRejectionReason],
  );

  // ── Compatibility wrappers (pure UI state, no orchestration) ────────────
  const onTypeAnswer = useCallback(() => {
    dispatch({ type: 'ask_user/set_waiting' });
  }, []);

  const setWaitingForRejectionReason = useCallback((value: boolean) => {
    dispatch({ type: value ? 'rejection/set_waiting' : 'rejection/cleared' });
  }, []);

  const setWaitingForAskUserAnswer = useCallback((value: boolean) => {
    dispatch({ type: value ? 'ask_user/set_waiting' : 'ask_user/clear_waiting' });
  }, []);

  // ── Return object (identical shape to the old monolith) ─────────────────
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
    submitConversationTurn,
    submitApprovalDecision,
    handleApprovalDecision,
    onTypeAnswer,
    clearConversation,
    stopProcessing: stopProcessingWithNotice,
    undoLastUserMessage,
    retryLastToolOutput,
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
    // Queue state
    queueActive,
    queuePaused,
    queueLength,
    queuePauseReason,
    pendingQueuedMessages,
    resumeQueue: () => conversationService.resumeQueue(),
    discardQueue: () => conversationService.discardQueue(),
    removeLastQueuedPendingMessage,
  };
};
