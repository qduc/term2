import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInputActions, useInputState } from './context/InputContext.js';
import { clearTerminalForRedraw, messagesHaveNonSystemContent } from './app-helpers.js';

import { Box, useApp, useStdout } from 'ink';
import { useConversation } from './hooks/use-conversation.js';
import MessageList, {
  detectStaticCommitBlocker,
  EMPTY_RESTORED_STATIC_MESSAGE_IDS,
  MESSAGE_HORIZONTAL_PADDING,
} from './components/message/MessageList.js';
import BottomArea from './components/layout/BottomArea.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import type { ConversationService } from './services/conversation/conversation-service.js';
import type { SettingsService } from './services/settings/settings-service.js';
import type { HistoryService } from './services/history-service.js';
import type { LoggingService } from './services/logging/logging-service.js';
import { ISSHService } from './services/service-interfaces.js';
import { useSetting } from './hooks/use-setting.js';
import { useDebouncedValue } from './hooks/use-debounced-value.js';
import { parseInput } from './utils/input-parser.js';
import { ConversationConfigurationService } from './services/runtime-setting-router.js';
import { useShellMode } from './hooks/use-shell-mode.js';
import { ShellInteractionSession, type SSHInfo } from './services/shell/shell-interaction-session.js';
import { useAppCommands } from './hooks/use-app-commands.js';
import { useHandoffFlow } from './hooks/use-handoff-flow.js';
import { useTerminalFocusNotifier } from './hooks/use-terminal-focus-notifier.js';
import { useAppKeyboardShortcuts } from './hooks/use-app-keyboard-shortcuts.js';
import { hasUserTurnContent, type UserTurn } from './types/user-turn.js';
import type { Message } from './types/message.js';
import { createUsageAccumulator, formatSessionUsageBreakdown, type UsageAccumulator } from './utils/ai/token-usage.js';
import {
  createSessionCostAccumulator,
  formatUsdMicros,
  type SessionCostAccumulator,
} from './services/cost/model-cost.js';
import type { RewindItem } from './utils/conversation/rewind-items.js';
import type { RewindDisposition } from './commands/rewind-command.js';
import { buildRewindItems } from './utils/conversation/rewind-items.js';
import { tryExecuteSlashCommand } from './utils/slash-command-dispatch.js';
import type { SkillsService, SkillInfo } from './services/skills/skills-service.js';
import { buildTerminalTitleLabel, setTerminalTitle } from './utils/output/terminal-title.js';
import { deriveInputOwner } from './lib/input-owner.js';
import { handleSettingsIntent } from './components/input/settings-intent-host.js';
import {
  registerSandboxNetworkApprovalHandler,
  type NetworkApprovalAnswer,
  type SandboxNetworkAccessRequest,
} from './utils/shell/sandbox/sandbox-network-approval.js';
import { SandboxNetworkApprovalCoordinator } from './utils/shell/sandbox/sandbox-network-approval-coordinator.js';
import { useFirstRunSetupGate } from './hooks/use-first-run-setup.js';

export {
  appendStartupBannerId,
  clearTerminalForRedraw,
  messagesHaveNonSystemContent,
  scheduleExitSideEffects,
  TERMINAL_REDRAW_CLEAR,
} from './app-helpers.js';

/**
 * How long the composer must be quiet before the large-uncached-input advisory
 * is recomputed. Long enough that a burst of typing costs one pass instead of
 * one per character, short enough that the notice appears while the user is
 * still looking at the text that triggered it.
 */
const LARGE_UNCACHED_PREVIEW_DEBOUNCE_MS = 250;

interface AppProps {
  conversationService: ConversationService;
  settingsService: SettingsService;
  historyService: HistoryService;
  loggingService: LoggingService;
  sshInfo?: SSHInfo;
  sshService?: ISSHService;
  usageAccumulator?: UsageAccumulator;
  subagentUsageAccumulator?: UsageAccumulator;
  costAccumulator?: SessionCostAccumulator;
  onPrintUsage?: () => void;
  onExitUsage?: () => void;
  sessionId: string;
  initialMessages?: Message[];
  restoredStaticMessageIds?: string[];
  logWriter?: { append: (event: any) => void };
  onRotateWriter?: (newSessionId: string) => void;
  generateId: () => string;
  onSessionIdChange?: (newId: string, createdAt: string) => void;
  onHasConversationContent?: (hasContent: boolean) => void;
  skillsService?: SkillsService;
  terminalTitleBase: string;
}

const App: FC<AppProps> = ({
  conversationService,
  settingsService,
  historyService,
  loggingService,
  sshInfo,
  sshService,
  usageAccumulator,
  subagentUsageAccumulator,
  costAccumulator,
  onPrintUsage,
  onExitUsage,
  sessionId: initialSessionId,
  initialMessages = [],
  restoredStaticMessageIds = EMPTY_RESTORED_STATIC_MESSAGE_IDS,
  logWriter,
  onRotateWriter,
  generateId,
  onSessionIdChange,
  onHasConversationContent,
  skillsService,
  terminalTitleBase,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { setInput, replaceInput, setImages } = useInputActions();
  const { input, mode, images: _images, controller } = useInputState();
  const menuOpen =
    typeof (controller as { getSnapshot?: () => { stack?: readonly unknown[] } }).getSnapshot === 'function'
      ? ((controller as { getSnapshot: () => { stack?: readonly unknown[] } }).getSnapshot().stack?.length ?? 0) > 0
      : mode !== 'text';
  const [messageListEpoch, setMessageListEpoch] = useState(0);
  const [startupBannerIds, setStartupBannerIds] = useState(['startup-banner-0']);
  const liteMode = useSetting(settingsService, 'app.liteMode') ?? false;
  const displayMode = useSetting(settingsService, 'ui.displayMode') ?? 'standard';
  const sessionUsage = useMemo(() => usageAccumulator ?? createUsageAccumulator(), [usageAccumulator]);
  const subagentUsage = useMemo(() => subagentUsageAccumulator ?? createUsageAccumulator(), [subagentUsageAccumulator]);
  const sessionCost = useMemo(() => costAccumulator ?? createSessionCostAccumulator(), [costAccumulator]);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const handleClearConversationRef = useRef<(() => Promise<void>) | null>(null);
  const pendingSkillRef = useRef<SkillInfo | null>(null);
  const sandboxApprovalCoordinatorRef = useRef<SandboxNetworkApprovalCoordinator | null>(null);
  const [sandboxPromptRequest, setSandboxPromptRequest] = useState<SandboxNetworkAccessRequest | null>(null);

  const notifier = useTerminalFocusNotifier({ stdout, settingsService, loggingService });

  useEffect(() => {
    const coordinator = new SandboxNetworkApprovalCoordinator();
    sandboxApprovalCoordinatorRef.current = coordinator;
    const unsubscribe = coordinator.subscribe(() => {
      setSandboxPromptRequest(coordinator.getSnapshot().activeRequest);
    });
    const unregister = registerSandboxNetworkApprovalHandler(async (request) => {
      return await coordinator.request(request);
    });

    return () => {
      unregister();
      unsubscribe();
      if (sandboxApprovalCoordinatorRef.current === coordinator) {
        sandboxApprovalCoordinatorRef.current = null;
      }
      coordinator.dispose();
    };
  }, []);

  const {
    messages,
    lastUsage,
    costSummary,
    lastCodexRateLimit,
    pendingApproval,
    waitingForApproval,
    waitingForRejectionReason,
    setWaitingForRejectionReason,
    waitingForAskUserAnswer,
    setWaitingForAskUserAnswer,
    currentAskUserQuestionIndex,
    isProcessing,
    thinkingStartedAt,
    toolCallStreamingInfo,
    backgroundSubagentTasks,
    backgroundSubagentTasksNow,
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
    onTypeAnswer,
    clearConversation,
    stopProcessing,
    cancelAskUser,
    rewindToTarget,
    retryLastToolOutput,
    getUserMessages,
    setModel,
    setReasoningEffort,
    addSystemMessage,
    setTemperature,
    addShellMessage,
    getSubagentUsage,
    goToPreviousQuestion,
    goToNextQuestion,
    queueActive: _queueActive,
    queuePaused,
    queueLength,
    queuePauseReason,
    pendingQueuedMessages,
    resumeQueue,
    discardQueue,
    retractPendingSubmission,
    editPendingSubmission,
    getCostSummary,
  } = useConversation({
    conversationService,
    loggingService,
    usageAccumulator: sessionUsage,
    subagentUsageAccumulator: subagentUsage,
    costAccumulator: sessionCost,
    initialMessages,
    sessionId,
    onClear: useCallback(async () => {
      if (handleClearConversationRef.current) {
        await handleClearConversationRef.current();
      }
    }, []),
    settingsService,
    historyService,
    onRestoreInput: setInput,
    logWriter,
    notifier,
  });

  // Keep older test/integration harnesses compatible while the session facade
  // rolls out the adopted-subagent approval channel.
  const backgroundApprovalState =
    backgroundSubagentApproval ?? ({ revision: 0, current: null, pendingCount: 0, closed: false } as const);
  const backgroundApprovalEntry = backgroundApprovalState.current;

  // Notify cli.tsx when the conversation has content so it can decide whether
  // to show the "To resume this conversation" message.
  useEffect(() => {
    onHasConversationContent?.(messagesHaveNonSystemContent(messages));
  }, [messages, onHasConversationContent]);

  const handleClearConversation = useCallback(async () => {
    const newId = generateId();
    const newCreatedAt = new Date().toISOString();
    if (onRotateWriter) {
      onRotateWriter(newId);
    }
    conversationService.resetWithNewId(newId);
    setSessionId(newId);
    if (onSessionIdChange) {
      onSessionIdChange(newId, newCreatedAt);
    }
  }, [generateId, conversationService, onSessionIdChange, onRotateWriter]);

  useEffect(() => {
    handleClearConversationRef.current = handleClearConversation;
  }, [handleClearConversation]);

  const configurationService = useMemo(
    () =>
      new ConversationConfigurationService({
        setModel,
        setReasoningEffort,
        setTemperature,
        conversationService,
        settingsService,
      }),
    [setModel, setReasoningEffort, setTemperature, conversationService, settingsService],
  );
  const applyRuntimeSetting = useCallback(
    (key: string, value: unknown) => configurationService.applyRuntimeSetting(key, value),
    [configurationService],
  );
  const applySetupProvider = useCallback(
    (provider: string) => {
      configurationService.apply([{ key: 'agent.provider', value: provider, persistence: 'runtime' }]);
    },
    [configurationService],
  );
  const firstRunSetup = useFirstRunSetupGate({
    settingsService,
    controller,
    applyProvider: applySetupProvider,
  });

  const shellInteractionSession = useMemo(
    () =>
      new ShellInteractionSession({
        settingsService,
        conversationSink: conversationService,
        liteMode,
        sshInfo,
        sshService,
      }),
    [conversationService, settingsService, sshInfo, sshService],
  );

  const { isShellMode, toggleShellMode, handleShellSubmit } = useShellMode({
    session: shellInteractionSession,
    addShellMessage,
    replaceInput,
    liteMode,
  });

  const clearConversationAndRefreshBanner = useCallback(async () => {
    onPrintUsage?.();
    await clearConversation();
    setStartupBannerIds(['startup-banner-0']);
    setMessageListEpoch((epoch) => epoch + 1);
  }, [clearConversation, onPrintUsage]);

  const handoff = useHandoffFlow({
    clearConversationAndRefreshBanner,
    addSystemMessage,
    sendUserMessage,
    replaceInput,
    controller,
    settingsService,
    applyRuntimeSetting,
    setModel,
    configurationService,
  });

  // The composer owns this live preview because it changes as the user types;
  // admitted turns and confirmation state belong to ConversationAdmissionWorkflow.
  //
  // The preview costs a full outgoing-history build plus a serialization of it,
  // so it scales with conversation length. Running it per keystroke blocked the
  // event loop between the key press and the repaint, which read as typing lag
  // in long sessions. Debounce it: the advisory only has to be right once the
  // user pauses, and the authoritative check still runs at submit time in
  // ConversationAdmissionWorkflow. An emptied composer flushes immediately so a
  // stale warning never outlives the text it described.
  const previewInput = useDebouncedValue(input, LARGE_UNCACHED_PREVIEW_DEBOUNCE_MS, (value) => value === '');
  const largeUncachedWarning = useMemo(() => {
    if (!previewInput || mode !== 'text' || previewInput.startsWith('/')) return null;
    const preview = conversationService.previewLargeUncachedInput({ text: previewInput }, Date.now());
    return preview.action === 'warn' ? preview : null;
  }, [conversationService, previewInput, mode]);

  const pendingSurgeTurn = admissionConfirmation?.kind === 'surge' ? admissionConfirmation.turn : null;
  const pendingSurgeReason = admissionConfirmation?.kind === 'surge' ? admissionConfirmation.reason : '';
  const pendingLargeUncachedTurn = admissionConfirmation?.kind === 'large_uncached' ? admissionConfirmation.turn : null;
  const pendingLargeUncachedTokens =
    admissionConfirmation?.kind === 'large_uncached' ? admissionConfirmation.estimatedTokens : 0;

  const resolveAdmission = useCallback(
    async (decision: 'approve' | 'decline') => {
      const confirmation = admissionConfirmation;
      if (!confirmation) return;
      const result = resolveAdmissionConfirmation(confirmation.id, decision);
      if (result.kind === 'stale') return;

      if (result.kind === 'declined') {
        queueMicrotask(() => replaceInput(result.turn.text || ''));
        return;
      }
      if (result.kind !== 'submitted') return;

      // Composer attachments are presentation state, and only a decision that
      // matched the displayed confirmation may clear them.
      replaceInput('');
      if (decision === 'approve') setImages([]);
      await result.completion;
    },
    [admissionConfirmation, replaceInput, resolveAdmissionConfirmation, setImages],
  );

  const handleLargeUncachedApprove = useCallback(() => resolveAdmission('approve'), [resolveAdmission]);
  const handleLargeUncachedDecline = useCallback(() => resolveAdmission('decline'), [resolveAdmission]);
  const handleSurgeApprove = useCallback(() => resolveAdmission('approve'), [resolveAdmission]);
  const handleSurgeDecline = useCallback(() => resolveAdmission('decline'), [resolveAdmission]);

  const submitAdmittedTurn = useCallback(
    async (turn: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) => {
      const result = options ? submitTurnForAdmission(turn, options) : submitTurnForAdmission(turn);
      if (result.kind === 'submitted') {
        replaceInput('');
        await result.completion;
      }
    },
    [replaceInput, submitTurnForAdmission],
  );

  const redrawMessageList = useCallback(() => {
    clearTerminalForRedraw(stdout);
    setMessageListEpoch((epoch) => epoch + 1);
  }, [stdout]);

  const getSessionUsage = useCallback(() => {
    const tokenUsage = formatSessionUsageBreakdown(sessionUsage.get(), getSubagentUsage());
    const summary = getCostSummary();
    if (!summary || summary.state === 'unavailable') {
      return tokenUsage;
    }

    const costLabel = summary.state === 'exact' ? 'Cost' : 'Estimated cost';
    const costAmount = `${formatUsdMicros(summary.knownUsdMicros)}${summary.state === 'partial' ? '+' : ''}`;
    const lowerBound = summary.state === 'partial' ? ' (lower bound)' : '';
    const costUsage = `${costLabel}: ${costAmount}${lowerBound} (${summary.pricedRequests} priced, ${summary.unpricedRequests} unpriced requests)`;
    return `${tokenUsage}\n${costUsage}`;
  }, [getCostSummary, getSubagentUsage, sessionUsage]);

  const staticCommitBlocker = useMemo(
    () => detectStaticCommitBlocker(messages, { displayMode }),
    [messages, displayMode],
  );

  const exitWithUsage = useCallback(() => {
    exit();
    onExitUsage?.();
  }, [exit, onExitUsage]);

  const handleSkillSelected = useCallback((skill: SkillInfo) => {
    pendingSkillRef.current = skill;
  }, []);

  /**
   * Put a rewound turn back where the user can edit it. Images ride along the
   * same way history recall restores them, so rewinding a multimodal turn does
   * not silently drop its attachments.
   */
  const restoreTurnToInput = useCallback(
    (turn: { text: string; images?: UserTurn['images'] }) => {
      replaceInput(turn.text);
      setImages(turn.images ?? []);
    },
    [replaceInput, setImages],
  );

  /** Rewind candidates carry a domain target id plus a UI-only trim boundary. */
  const openRewindPickerItems = useCallback(
    () => buildRewindItems(getUserMessages(), conversationService.listRewindTargets()),
    [getUserMessages, conversationService],
  );

  const openRewindMenu = useCallback(
    (disposition: RewindDisposition) => {
      const items = openRewindPickerItems();
      if (items.length === 0) {
        addSystemMessage('Nothing to rewind.');
        return;
      }
      // An external surface owns the interaction from this point; discard any
      // text-triggered frame that was used to invoke the command.
      controller.closeAll();
      controller.open({ kind: 'rewind', items, initialDisposition: disposition });
    },
    [addSystemMessage, controller, openRewindPickerItems],
  );

  const { slashCommands, cycleAppModes } = useAppCommands({
    settingsService,
    addSystemMessage,
    applyRuntimeSetting,
    replaceInput,
    clearConversation: clearConversationAndRefreshBanner,
    getSessionUsage,
    exit: exitWithUsage,
    messages,
    setModel,
    getRewindItems: openRewindPickerItems,
    rewindToTarget: (item) => rewindToTarget(item.targetId, item.uiIndex),
    restoreTurnToInput,
    retryLastToolOutput,
    onRewind: redrawMessageList,
    openRewindMenu,
    openProvidersMenu: () => {
      controller.closeAll();
      controller.open({ kind: 'providers' });
    },
    onHandoff: handoff.startHandoff,
    sendUserMessage,
    skillsService: skillsService ?? ({ getAvailableSkills: () => [] } as unknown as SkillsService),
    onSkillSelected: handleSkillSelected,
  });

  const handleRewindSelect = useCallback(
    (item: RewindItem, disposition: RewindDisposition) => {
      const rewound = rewindToTarget(item.targetId, item.uiIndex);
      if (!rewound) return;

      redrawMessageList();
      if (disposition === 'resend') {
        replaceInput('');
        setImages([]);
        void sendUserMessage({ text: rewound.text, ...(rewound.images?.length ? { images: rewound.images } : {}) });
        return;
      }
      restoreTurnToInput(rewound);
    },
    [rewindToTarget, redrawMessageList, replaceInput, restoreTurnToInput, sendUserMessage, setImages],
  );

  const handleApprove = useCallback(
    async (answer?: string) => {
      if (sandboxPromptRequest) {
        sandboxApprovalCoordinatorRef.current?.resolve(
          sandboxPromptRequest,
          (answer as NetworkApprovalAnswer) ?? 'allow-once',
        );
        return;
      }
      if (backgroundApprovalEntry) {
        resolveBackgroundSubagentApproval({
          revision: backgroundApprovalState.revision,
          entry: backgroundApprovalEntry,
          decision: { answer: answer ?? 'yes' },
        });
        return;
      }
      await submitApprovalDecision(answer);
    },
    [
      backgroundApprovalEntry,
      backgroundApprovalState.revision,
      resolveBackgroundSubagentApproval,
      sandboxPromptRequest,
      submitApprovalDecision,
    ],
  );

  const handleReject = useCallback(() => {
    if (sandboxPromptRequest) {
      sandboxApprovalCoordinatorRef.current?.resolve(sandboxPromptRequest, 'deny');
      return;
    }
    if (backgroundApprovalEntry) {
      setWaitingForRejectionReason(true);
      return;
    }
    setWaitingForRejectionReason(true);
  }, [
    backgroundApprovalEntry,
    backgroundApprovalState.revision,
    resolveBackgroundSubagentApproval,
    sandboxPromptRequest,
    setWaitingForRejectionReason,
  ]);

  const handleCancelAskUser = useCallback(() => {
    if (sandboxPromptRequest || pendingApproval?.toolName !== 'ask_user') return;
    cancelAskUser();
  }, [cancelAskUser, pendingApproval, sandboxPromptRequest]);

  const backgroundPendingApproval: import('./contracts/conversation.js').ApprovalDescriptor | null =
    backgroundApprovalEntry
      ? {
          agentName: `${backgroundApprovalEntry.runId} (${backgroundApprovalEntry.toolName})`,
          toolName: backgroundApprovalEntry.toolName,
          argumentsText: backgroundApprovalEntry.argumentsText,
          rawInterruption: { runId: backgroundApprovalEntry.runId },
          callId: backgroundApprovalEntry.toolCallId,
        }
      : null;
  const effectivePendingApproval =
    sandboxPromptRequest === null
      ? backgroundPendingApproval ?? pendingApproval
      : {
          agentName: 'Sandbox',
          toolName: 'sandbox_network_access',
          argumentsText: `Allow network access to ${sandboxPromptRequest.host}${
            sandboxPromptRequest.port == null ? '' : `:${sandboxPromptRequest.port}`
          }?`,
          rawInterruption: sandboxPromptRequest,
        };
  const effectiveWaitingForApproval = sandboxPromptRequest || backgroundPendingApproval ? true : waitingForApproval;
  const effectiveWaitingForRejectionReason = sandboxPromptRequest ? false : waitingForRejectionReason;
  const effectiveWaitingForAskUserAnswer = sandboxPromptRequest ? false : waitingForAskUserAnswer;
  const effectiveIsProcessing = sandboxPromptRequest || backgroundPendingApproval ? false : isProcessing;

  // Single source of truth for "which surface owns keyboard input right now."
  // Computed from the same effective state passed to BottomArea so the app
  // keyboard-shortcuts hook stays suppressed whenever a modal confirmation
  // prompt is rendered (Closing the Ink fan-out coupling — see input-owner.ts).
  const inputOwner = deriveInputOwner({
    handoffStage: handoff.handoffState?.stage ?? null,
    pendingSurgeTurn,
    pendingLargeUncachedTurn,
    waitingForApproval: effectiveWaitingForApproval,
    waitingForRejectionReason: effectiveWaitingForRejectionReason,
    waitingForAskUserAnswer: effectiveWaitingForAskUserAnswer,
    pendingApproval: effectivePendingApproval,
    queuePaused,
    firstRunSetupActive: firstRunSetup.active,
    isProcessing: effectiveIsProcessing,
    menuOpen,
  });

  useEffect(() => {
    setTerminalTitle(buildTerminalTitleLabel(terminalTitleBase, effectiveIsProcessing));
  }, [effectiveIsProcessing, terminalTitleBase]);

  const handleNavigateQuestion = useCallback(
    (direction: 'prev' | 'next') => {
      if (direction === 'prev') {
        goToPreviousQuestion();
      } else {
        goToNextQuestion();
      }
    },
    [goToPreviousQuestion, goToNextQuestion],
  );

  const { interruptConfirmVisible } = useAppKeyboardShortcuts({
    exitWithUsage,
    pendingSkillRef,
    waitingForAskUserAnswer: effectiveWaitingForAskUserAnswer,
    setWaitingForAskUserAnswer,
    waitingForRejectionReason: effectiveWaitingForRejectionReason,
    setWaitingForRejectionReason,
    inputMode: mode,
    inputValue: input,
    isProcessing: effectiveIsProcessing,
    waitingForApproval: effectiveWaitingForApproval,
    stopProcessing,
    handoffState: handoff.handoffState,
    cancelHandoff: handoff.cancelHandoff,
    pendingLargeUncachedTurn,
    liteMode,
    toggleShellMode,
    cycleAppModes,
    replaceInput,
    onSkillActivationCancelled: () => addSystemMessage('Skill activation cancelled.'),
    inputOwner,
  });

  const handleSubmit = async (turn: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }): Promise<void> => {
    if (backgroundApprovalEntry && waitingForRejectionReason) {
      resolveBackgroundSubagentApproval({
        revision: backgroundApprovalState.revision,
        entry: backgroundApprovalEntry,
        decision: { answer: 'no', rejectionReason: turn.text },
      });
      setWaitingForRejectionReason(false);
      return;
    }
    if (await submitConversationTurn(turn)) {
      return;
    }

    const value = turn.text;
    const hasImages = Boolean(turn.images?.length);
    if (!hasUserTurnContent(turn) && handoff.handoffState?.stage !== 'entering_message') return;

    if (liteMode && isShellMode && !hasImages) {
      await handleShellSubmit(value);
      return;
    }

    if (await handoff.submitHandoffInput(turn)) {
      return;
    }

    const parsed = parseInput(value);
    const attachPendingSkill = (baseTurn: UserTurn): UserTurn => {
      const pendingSkill = pendingSkillRef.current;
      if (!pendingSkill) {
        return baseTurn;
      }

      pendingSkillRef.current = null;
      return {
        ...baseTurn,
        skill: {
          name: pendingSkill.name,
          description: pendingSkill.description,
          body: pendingSkill.body,
        },
      };
    };

    switch (parsed.type) {
      case 'slash-command': {
        if (hasImages) {
          break;
        }
        if (tryExecuteSlashCommand(value, slashCommands, replaceInput)) {
          return;
        }
        // Command not found, fall through to send as message
        break;
      }

      case 'message':
        return await submitAdmittedTurn(attachPendingSkill(turn), options);
    }

    await submitAdmittedTurn(attachPendingSkill(turn), options);
  };

  const handleSettingChange = useCallback(
    (key: string, value: any) => {
      applyRuntimeSetting(key, value);
      if (handoff.handoffState?.stage === 'selecting_effort' && key === 'agent.reasoningEffort') {
        void handoff.completeHandoffWithEffort(String(value));
      }
    },
    [applyRuntimeSetting, handoff],
  );
  const handleConfigurationSettingChange = useCallback(
    (key: string, value: unknown) => {
      if (handoff.handoffState?.stage === 'selecting_effort' && key === 'agent.reasoningEffort') {
        void handoff.completeHandoffWithEffort(String(value));
      }
    },
    [handoff],
  );

  // The application effect host: executes typed domain intents only after
  // the controller has committed the required input and stack transition.
  // Settings/model application is the first production user of a correlated
  // IntentResult (success or field error) delivered back to the originating
  // frame; rewind remains fire-and-forget.
  useEffect(() => {
    controller.setIntentHost(({ intentRequest }) => {
      if (intentRequest.intent.type === 'rewind') {
        handleRewindSelect(intentRequest.intent.item, intentRequest.intent.disposition);
        return;
      }
      if (intentRequest.intent.type === 'submit-prompt') {
        // A captured handoff intercepts its own model selection here rather
        // than through `handleSubmit`: the direct `/model ` trigger is
        // controller-owned, so an accepted selection never routes through a
        // submitted turn. See `useHandoffFlow`'s `handleModelSubmitPrompt`.
        if (handoff.handleModelSubmitPrompt(intentRequest.intent.text)) {
          return;
        }
        // Text composed by a controller-owned menu (e.g. accepting a direct
        // `/model gpt-4` selection) is exactly what the user would have
        // typed and pressed Enter on, so it goes through the same slash-
        // command dispatch as handleSubmit before falling back to sending it
        // as ordinary content — otherwise a resolved command like `/model`
        // would be posted to the model as a literal chat message instead of
        // being executed.
        if (tryExecuteSlashCommand(intentRequest.intent.text, slashCommands, replaceInput)) {
          return;
        }
        void submitAdmittedTurn({ text: intentRequest.intent.text });
        return;
      }
      const result = handleSettingsIntent(intentRequest, {
        settingsService,
        configurationService,
        onSettingChange: handleConfigurationSettingChange,
        onSystemMessage: addSystemMessage,
        applyRuntimeSetting,
      });
      if (
        result?.ok &&
        intentRequest.intent.type === 'apply-settings' &&
        intentRequest.intent.changes.some((change) => change.key === 'agent.model')
      ) {
        firstRunSetup.completeModelSelection();
      }
      return result;
    });
    return () => controller.setIntentHost(undefined);
  }, [
    controller,
    handleRewindSelect,
    submitAdmittedTurn,
    settingsService,
    handleSettingChange,
    addSystemMessage,
    applyRuntimeSetting,
    handoff,
    slashCommands,
    replaceInput,
    firstRunSetup,
  ]);

  return (
    <ErrorBoundary loggingService={loggingService}>
      <Box flexDirection="column" flexGrow={1}>
        {/* Main content area grows to fill available vertical space */}
        <Box flexDirection="column" flexGrow={1}>
          <MessageList
            key={messageListEpoch}
            messages={messages}
            bannerItems={startupBannerIds}
            settingsService={settingsService}
            isShellMode={isShellMode}
            restoredStaticMessageIds={restoredStaticMessageIds}
          />
        </Box>

        {/* Fixed bottom area for input / status */}
        <Box paddingX={MESSAGE_HORIZONTAL_PADDING}>
          <BottomArea
            pendingApproval={effectivePendingApproval}
            waitingForApproval={effectiveWaitingForApproval}
            waitingForRejectionReason={effectiveWaitingForRejectionReason}
            waitingForAskUserAnswer={effectiveWaitingForAskUserAnswer}
            currentAskUserQuestionIndex={currentAskUserQuestionIndex}
            isProcessing={effectiveIsProcessing}
            interruptConfirmVisible={interruptConfirmVisible}
            thinkingStartedAt={thinkingStartedAt}
            toolCallStreamingInfo={toolCallStreamingInfo}
            isShellMode={isShellMode}
            lastUsage={lastUsage}
            costSummary={costSummary}
            queuePaused={queuePaused}
            queueLength={queueLength}
            queuePauseReason={queuePauseReason}
            onResumeQueue={resumeQueue}
            onDiscardQueue={discardQueue}
            pendingQueuedMessages={pendingQueuedMessages}
            backgroundSubagentTasks={backgroundSubagentTasks}
            backgroundSubagentTasksNow={backgroundSubagentTasksNow}
            listBackgroundTaskDetails={listBackgroundTaskDetails}
            getBackgroundTaskDetails={getBackgroundTaskDetails}
            stopBackgroundTask={stopBackgroundTask}
            getForegroundTaskTransferCandidate={getForegroundTaskTransferCandidate}
            moveForegroundTaskToBackground={moveForegroundTaskToBackground}
            listForegroundTaskTransferCandidates={listForegroundTaskTransferCandidates}
            backgroundApprovalPendingCount={backgroundApprovalState.pendingCount}
            onRetractQueuedMessage={retractPendingSubmission}
            onEditQueuedMessage={editPendingSubmission}
            onSubmit={handleSubmit}
            slashCommands={slashCommands}
            skillsService={skillsService}
            settingsService={settingsService}
            loggingService={loggingService}
            historyService={historyService}
            onApprove={handleApprove}
            onReject={handleReject}
            onCancel={handleCancelAskUser}
            onTypeAnswer={onTypeAnswer}
            onNavigateQuestion={handleNavigateQuestion}
            sshInfo={sshInfo}
            lastCodexRateLimit={lastCodexRateLimit}
            staticCommitBlocker={staticCommitBlocker}
            firstRunSetup={firstRunSetup}
            onProviderSelected={firstRunSetup.active ? firstRunSetup.onProviderSelected : undefined}
            onUnavailableModelSelected={firstRunSetup.requestSetup}
            onSettingChange={handleSettingChange}
            onSystemMessage={addSystemMessage}
            handoffState={handoff.handoffState}
            onHandoffConfirm={handoff.confirmHandoff}
            onHandoffDecline={handoff.declineHandoff}
            onHandoffCancel={handoff.cancelHandoff}
            onStandardModeConfirm={handoff.confirmStandardMode}
            onStandardModeDecline={handoff.declineStandardMode}
            largeUncachedWarning={largeUncachedWarning}
            pendingLargeUncachedTurn={pendingLargeUncachedTurn}
            pendingLargeUncachedTokens={pendingLargeUncachedTokens}
            onLargeUncachedApprove={handleLargeUncachedApprove}
            onLargeUncachedDecline={handleLargeUncachedDecline}
            pendingSurgeTurn={pendingSurgeTurn}
            pendingSurgeReason={pendingSurgeReason}
            onSurgeApprove={handleSurgeApprove}
            onSurgeDecline={handleSurgeDecline}
            onSlashTabComplete={(command) => {
              if (command.name === 'rewind' || command.name === 'undo' || command.name === 'retry') {
                openRewindMenu(command.name === 'retry' ? 'resend' : 'edit');
                return true;
              }
              return false;
            }}
          />
        </Box>
      </Box>
    </ErrorBoundary>
  );
};

export default App;
