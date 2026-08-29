import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
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
import type { RewindTargetId } from '../services/conversation/conversation-store.js';
import { conversationUIReducer, createInitialUIState, getConversationUIFlags } from './conversation-ui-reducer.js';
import type { BackgroundTask } from '../services/subagents/subagent-notification-store.js';
import type { BackgroundTaskControlDetails } from '../services/session/background-task-control.js';
import { needsBackgroundTaskClock } from '../components/layout/background-task-clock.js';
import type {
  BackgroundSubagentApprovalSnapshot,
  BackgroundSubagentApprovalResolutionRequest,
} from '../services/approval/background-subagent-approval-queue.js';
import type { SessionCostAccumulator } from '../services/cost/model-cost.js';
import {
  ConversationAdmissionWorkflow,
  type AdmissionOptions,
} from '../services/conversation/conversation-admission-workflow.js';
import type { HistoryService } from '../services/history-service.js';

import type { ConversationLogWriter } from '../services/logging/conversation-log-writer.js';

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
type ConversationTransportOptions = AdmissionOptions & { bypassInputSurgeGuard?: boolean };

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
  costAccumulator,
  initialMessages = [],
  sessionId,
  onClear,
  settingsService,
  historyService,
  replaceInput,
  onRestoreInput,
  logWriter,
  notifier,
}: {
  conversationService: ConversationService;
  loggingService: ILoggingService;
  usageAccumulator?: UsageAccumulator;
  subagentUsageAccumulator?: UsageAccumulator;
  costAccumulator?: SessionCostAccumulator;
  initialMessages?: Message[];
  sessionId?: string;
  onClear?: () => void | Promise<void>;
  settingsService?: SettingsService;
  historyService: Pick<HistoryService, 'addMessage'>;
  replaceInput?: (text: string) => void;
  /**
   * Called when a user message could not be sent (e.g. upstream error before any
   * stream tokens, or input-surge guard) and the session dropped it from the
   * conversation store. The UI removes the trailing user message and forwards
   * the original text here so the caller can repopulate the input box.
   */
  onRestoreInput?: (text: string) => void;
  logWriter?: Pick<ConversationLogWriter, 'append'>;
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
  const {
    thinkingStartedAt,
    toolCallStreamingInfo,
    lastUsage,
    lastCodexRateLimit,
    runBudgetNotice,
    costSummary,
    pendingQueuedMessages,
  } = uiState;
  const {
    isProcessing,
    pendingInteractionId,
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

  const provider = useSetting(settingsService || dummySettingsService, 'agent.provider') ?? 'openai';
  const readBackgroundSubagentTasks = useCallback(
    (): { tasks: readonly BackgroundTask[]; now: number } => ({
      tasks: conversationService.backgroundSubagentTasks?.getSnapshot?.() ?? [],
      now: Date.now(),
    }),
    [conversationService],
  );
  const [backgroundSubagentTaskState, setBackgroundSubagentTaskState] = useState(readBackgroundSubagentTasks);
  const readBackgroundTaskDetails = useCallback(
    (): { tasks: readonly BackgroundTaskControlDetails[]; now: number } => ({
      tasks: conversationService.backgroundTaskControl?.listDetails?.() ?? [],
      now: Date.now(),
    }),
    [conversationService],
  );
  const [backgroundTaskDetailsState, setBackgroundTaskDetailsState] = useState(readBackgroundTaskDetails);
  const readForegroundTransferCandidates = useCallback(
    () => conversationService.backgroundTaskControl?.listForegroundTransferCandidates?.() ?? [],
    [conversationService],
  );
  const [foregroundTransferCandidates, setForegroundTransferCandidates] = useState(readForegroundTransferCandidates);
  const readBackgroundApproval = useCallback(
    (): BackgroundSubagentApprovalSnapshot =>
      conversationService.backgroundSubagentApprovals?.getSnapshot?.() ?? { pendingCount: 0, pending: [] },
    [conversationService],
  );
  const [backgroundSubagentApproval, setBackgroundSubagentApproval] = useState(readBackgroundApproval);

  const refreshBackgroundSubagentTasks = useCallback(() => {
    setBackgroundSubagentTaskState(readBackgroundSubagentTasks());
    setBackgroundTaskDetailsState(readBackgroundTaskDetails());
    setForegroundTransferCandidates(readForegroundTransferCandidates());
  }, [readBackgroundSubagentTasks, readBackgroundTaskDetails, readForegroundTransferCandidates]);

  const listBackgroundTaskDetails = useCallback(
    () => conversationService.backgroundTaskControl?.listDetails?.() ?? [],
    [conversationService],
  );
  const getBackgroundTaskDetails = useCallback(
    (target: import('../services/session/background-task-control.js').BackgroundTaskControlTarget) =>
      conversationService.backgroundTaskControl?.getDetails?.(target) ?? null,
    [conversationService],
  );
  const stopBackgroundTask = useCallback(
    (target: import('../services/session/background-task-control.js').BackgroundTaskControlTarget) =>
      conversationService.backgroundTaskControl?.requestStop?.(target) ?? false,
    [conversationService],
  );
  const getForegroundTaskTransferCandidate = useCallback(
    () => conversationService.backgroundTaskControl?.getForegroundTransferCandidate?.() ?? null,
    [conversationService],
  );
  const listForegroundTaskTransferCandidates = useCallback(
    () => conversationService.backgroundTaskControl?.listForegroundTransferCandidates?.() ?? [],
    [conversationService],
  );
  const moveForegroundTaskToBackground = useCallback(
    (target: import('../services/session/background-task-control.js').ForegroundTaskControlTarget) =>
      conversationService.backgroundTaskControl?.moveForegroundToBackground?.(target) ?? false,
    [conversationService],
  );

  useEffect(() => {
    if (typeof conversationService.setBackgroundSubagentTaskObserver !== 'function') return;
    conversationService.setBackgroundSubagentTaskObserver(refreshBackgroundSubagentTasks);
    return () => conversationService.setBackgroundSubagentTaskObserver(null);
  }, [conversationService, refreshBackgroundSubagentTasks]);

  const backgroundClockNeeded = needsBackgroundTaskClock({
    snapshotTasks: backgroundSubagentTaskState.tasks,
    detailsTasks: backgroundTaskDetailsState.tasks,
    foregroundCount: foregroundTransferCandidates.length,
    turnInFlight: isProcessing,
    now: Math.max(backgroundSubagentTaskState.now, backgroundTaskDetailsState.now),
  });

  useEffect(() => {
    // Tick only while live work or the panel linger still needs `now`.
    // Retained terminal registry rows outlive that window on purpose (Ctrl+G);
    // they must not keep a 1s Ink redraw after the agent is idle.
    if (!backgroundClockNeeded) return;
    const interval = setInterval(refreshBackgroundSubagentTasks, 1_000);
    return () => clearInterval(interval);
  }, [backgroundClockNeeded, refreshBackgroundSubagentTasks]);

  useEffect(() => {
    if (typeof conversationService.backgroundSubagentApprovals?.subscribe !== 'function') return;
    return conversationService.backgroundSubagentApprovals.subscribe(() =>
      setBackgroundSubagentApproval(readBackgroundApproval()),
    );
  }, [conversationService, readBackgroundApproval]);

  const resolveBackgroundSubagentApproval = useCallback(
    (request: BackgroundSubagentApprovalResolutionRequest) =>
      conversationService.backgroundSubagentApprovals?.resolve?.(request),
    [conversationService],
  );

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
        onCostUpdate: (summary) => dispatch({ type: 'cost/updated', summary }),
        onRateLimitUpdate: (rateLimit) => dispatch({ type: 'rate_limit/updated', rateLimit }),
        onRunBudgetNotice: (event) => dispatch({ type: 'run_budget/noticed', event }),
        onRateLimitClear: () => dispatch({ type: 'rate_limit/cleared' }),
        onResetTransient: () => dispatch({ type: 'reset_transient' }),
        onResetAll: () => dispatch({ type: 'reset_all' }),
        onStreamingThinkingStarted: (timestamp) => dispatch({ type: 'streaming/thinking_started', timestamp }),
        onStreamingThinkingCleared: () => dispatch({ type: 'streaming/thinking_cleared' }),
        onStreamingToolInfo: (info) => dispatch({ type: 'streaming/tool_info', info }),
        onAskUserAnswerSubmitted: () => {},
        onAskUserAdvanceToNext: () => {},
        onAskUserGoBack: () => {},
        onQueueStateChange: (snapshot) => dispatch({ type: 'queue/updated', snapshot }),
        onQueuedMessagePending: (id, text) =>
          dispatch({ type: 'queue/message_pending', id, text, queuedAt: Date.now() }),
        onQueuedMessageStarted: (id) => dispatch({ type: 'queue/message_started', id }),
        onQueuedMessageRemoved: (id) => dispatch({ type: 'queue/message_removed', id }),
        onQueuedMessageEdited: (id, text) => dispatch({ type: 'queue/message_edited', id, text }),
      },
      approvedContext: approvedContextRef,
      usageAccumulator,
      subagentUsageAccumulator,
      costAccumulator,
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

  useEffect(() => {
    if (typeof conversationService.setPendingInteractionObserver !== 'function') return;
    conversationService.setPendingInteractionObserver((snapshot) => {
      dispatch({ type: 'interaction/snapshot', snapshot });
    });
    return () => conversationService.setPendingInteractionObserver(null);
  }, [conversationService]);

  // ── Public API — all orchestration delegates to the orchestrator ─────────
  const sendThroughOrchestrator = useCallback(
    (input: string | UserTurn, options?: ConversationTransportOptions) => orchestrator.sendUserMessage(input, options),
    [orchestrator],
  );

  // Direct UI callers can send a turn but cannot manufacture a guard bypass.
  // Admission is the only public hook API that carries busy-mode policy.
  const sendUserMessage = useCallback(
    (input: string | UserTurn) => sendThroughOrchestrator(input),
    [sendThroughOrchestrator],
  );

  const admissionWorkflowRef = useRef<ConversationAdmissionWorkflow | null>(null);
  if (!admissionWorkflowRef.current) {
    admissionWorkflowRef.current = new ConversationAdmissionWorkflow({
      conversation: conversationService,
      history: historyService,
      logger: loggingService,
      send: (turn, options) => sendThroughOrchestrator(turn, options),
    });
  }
  const admissionWorkflow = admissionWorkflowRef.current;
  const admissionConfirmation = useSyncExternalStore(
    (listener) => admissionWorkflow.subscribe(listener),
    () => admissionWorkflow.getSnapshot(),
    () => admissionWorkflow.getSnapshot(),
  );

  const submitTurnForAdmission = useCallback(
    (turn: UserTurn, options?: AdmissionOptions) => admissionWorkflow.submit(turn, options),
    [admissionWorkflow],
  );

  const resolveAdmissionConfirmation = useCallback(
    (id: string, decision: 'approve' | 'decline') => admissionWorkflow.resolve(id, decision),
    [admissionWorkflow],
  );

  const handleApprovalDecision = useCallback(
    (answer: string, rejectionReason?: string, approvalAnswer?: string) => {
      if (pendingInteractionId === null) return Promise.resolve();
      return orchestrator.handleApprovalDecision(answer, rejectionReason, approvalAnswer, pendingInteractionId);
    },
    [orchestrator, pendingInteractionId],
  );

  const clearConversation = useCallback(() => orchestrator.clearConversation(), [orchestrator]);

  const stopProcessing = useCallback(() => orchestrator.stopProcessing(), [orchestrator]);

  const stopProcessingWithNotice = useCallback(() => {
    stopProcessing();
    addSystemMessage('Stopped');
  }, [stopProcessing, addSystemMessage]);

  // Not `stopProcessing`: aborting a paused turn discards the whole segment,
  // so the question the model asked would vanish from history. Resolving it
  // with a "no answer" result ends the turn *and* keeps the record.
  const cancelAskUser = useCallback(() => {
    if (pendingInteractionId === null) return Promise.resolve();
    return orchestrator.cancelAskUser(pendingInteractionId);
  }, [orchestrator, pendingInteractionId]);

  const rewindToTarget = useCallback<
    (targetId: RewindTargetId, uiIndex: number) => { text: string; images?: UserTurn['images'] } | null
  >((targetId, uiIndex) => orchestrator.rewindToTarget(targetId, uiIndex), [orchestrator]);

  const compactContext = useCallback(() => orchestrator.compactContext(), [orchestrator]);

  const retryLastToolOutput = useCallback<() => Promise<boolean>>(
    () => orchestrator.retryLastToolOutput(),
    [orchestrator],
  );

  const retractPendingSubmission = useCallback(
    (id: string) => orchestrator.retractPendingSubmission(id),
    [orchestrator],
  );

  const editPendingSubmission = useCallback(
    (id: string, turn: UserTurn) => orchestrator.editPendingSubmission(id, turn),
    [orchestrator],
  );

  const getSubagentUsage = useCallback(() => orchestrator.getSubagentUsage(), [orchestrator]);
  const getCostSummary = useCallback(() => orchestrator.getCostSummary(), [orchestrator]);

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
    dispatch({ type: 'interaction/composer_entry', mode: 'ask_user_answer' });
  }, []);

  const setWaitingForRejectionReason = useCallback((value: boolean) => {
    dispatch({ type: 'interaction/composer_entry', mode: value ? 'rejection_reason' : 'none' });
  }, []);

  const setWaitingForAskUserAnswer = useCallback((value: boolean) => {
    dispatch({ type: 'interaction/composer_entry', mode: value ? 'ask_user_answer' : 'none' });
  }, []);

  // ── Return object (identical shape to the old monolith) ─────────────────
  return {
    messages,
    sessionId: sessionId ?? conversationService.sessionId,
    lastUsage,
    costSummary,
    lastCodexRateLimit,
    runBudgetNotice,
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
    backgroundSubagentTasks: backgroundSubagentTaskState.tasks,
    backgroundSubagentTasksNow: backgroundSubagentTaskState.now,
    backgroundTaskDetails: backgroundTaskDetailsState.tasks,
    backgroundTaskDetailsNow: backgroundTaskDetailsState.now,
    listBackgroundTaskDetails,
    getBackgroundTaskDetails,
    stopBackgroundTask,
    getForegroundTaskTransferCandidate,
    moveForegroundTaskToBackground,
    listForegroundTaskTransferCandidates,
    backgroundSubagentApproval,
    resolveBackgroundSubagentApproval,
    sendUserMessage,
    admissionConfirmation,
    submitTurnForAdmission,
    resolveAdmissionConfirmation,
    submitConversationTurn,
    submitApprovalDecision,
    handleApprovalDecision,
    onTypeAnswer,
    clearConversation,
    stopProcessing: stopProcessingWithNotice,
    cancelAskUser,
    rewindToTarget,
    retryLastToolOutput,
    compactContext,
    getUserMessages,
    setModel,
    setReasoningEffort,
    setTemperature,
    addSystemMessage,
    addShellMessage,
    getSubagentUsage,
    getCostSummary,
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
    retractPendingSubmission,
    editPendingSubmission,
  };
};
