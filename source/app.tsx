import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInputActions, useInputState } from './context/InputContext.js';
import { clearTerminalForRedraw, clearVisibleForResize, messagesHaveNonSystemContent } from './app-helpers.js';

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
import { useGrokCreditUsage } from './hooks/use-grok-credit-usage.js';
import { useOpenCodeGoUsage } from './hooks/use-opencode-go-usage.js';
import { useSetting } from './hooks/use-setting.js';
import { useDebouncedValue } from './hooks/use-debounced-value.js';
import type { LargeUncachedInputDecision } from './services/large-uncached-input-guard.js';
import { parseInput } from './utils/input-parser.js';
import { ConversationConfigurationService } from './services/runtime-setting-router.js';
import { useShellMode } from './hooks/use-shell-mode.js';
import { ShellInteractionSession, type SSHInfo } from './services/shell/shell-interaction-session.js';
import { useAppCommands } from './hooks/use-app-commands.js';
import { type PendingModeSwitch, EXCLUSIVE_MODE_KEYS } from './commands/mode-commands.js';
import { useHandoffFlow } from './hooks/use-handoff-flow.js';
import { useTerminalFocusNotifier } from './hooks/use-terminal-focus-notifier.js';
import { useAppKeyboardShortcuts } from './hooks/use-app-keyboard-shortcuts.js';
import { hasUserTurnContent, type UserTurn } from './types/user-turn.js';
import type { Message } from './types/message.js';
import { createUsageAccumulator, formatSessionUsageBreakdown, type UsageAccumulator } from './utils/ai/token-usage.js';
import {
  createSessionCostAccumulator,
  formatModelUsageBreakdown,
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
import { publishHarnessInputState } from './lib/harness-input-idle.js';
import { handleSettingsIntent } from './components/input/settings-intent-host.js';
import {
  registerSandboxNetworkApprovalHandler,
  type NetworkApprovalAnswer,
  type SandboxNetworkAccessRequest,
} from './utils/shell/sandbox/sandbox-network-approval.js';
import { SandboxNetworkApprovalCoordinator } from './utils/shell/sandbox/sandbox-network-approval-coordinator.js';
import { useFirstRunSetupGate } from './hooks/use-first-run-setup.js';
import { TOOL_NAME_ASK_USER } from './tools/tool-names.js';
import { copyToClipboard } from './utils/clipboard.js';
import type { CopySelection } from './utils/copy-selections.js';
import {
  isConversationLocked,
  listConversations,
  loadConversationForProject,
  loadLastConversation,
  type ConversationListEntry,
  type RestoredState,
} from './services/conversation/conversation-persistence.js';
import { normalizeAppModes } from './services/settings/settings-schema.js';

export {
  appendStartupBannerId,
  clearTerminalForRedraw,
  clearVisibleForResize,
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

/** How long after the last resize event the terminal must stay quiet before a redraw fires. */
const RESIZE_SETTLED_MS = 300;

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
  onRotateWriter?: (newSessionId: string, createdAt?: string) => void;
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
  const [activeRestoredStaticMessageIds, setActiveRestoredStaticMessageIds] = useState(restoredStaticMessageIds);
  const displayMode = useSetting(settingsService, 'ui.displayMode') ?? 'concise';
  const sessionUsage = useMemo(() => usageAccumulator ?? createUsageAccumulator(), [usageAccumulator]);
  const subagentUsage = useMemo(() => subagentUsageAccumulator ?? createUsageAccumulator(), [subagentUsageAccumulator]);
  const sessionCost = useMemo(() => costAccumulator ?? createSessionCostAccumulator(), [costAccumulator]);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [backgroundTaskManagerOpen, setBackgroundTaskManagerOpen] = useState(false);
  const handleClearConversationRef = useRef<(() => Promise<void>) | null>(null);
  const sessionRolloverHandlerRef = useRef<
    ((request: import('./contracts/session-rollover.js').SessionRolloverRequest) => void | Promise<void>) | null
  >(null);
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
    runBudgetNotice,
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
    backgroundTaskDetails,
    backgroundTaskDetailsNow,
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
    restoreConversation,
    stopProcessing,
    cancelAskUser,
    rewindToTarget,
    retryLastToolOutput,
    compactContext,
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
    onSessionRollover: (request) => sessionRolloverHandlerRef.current?.(request),
    settingsService,
    historyService,
    onRestoreInput: setInput,
    logWriter,
    notifier,
  });

  sessionRolloverHandlerRef.current = async (request) => {
    conversationService.logSessionRollover(request);
    await clearConversation();
    await sendUserMessage(request.brief);
  };

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
        sshInfo,
        sshService,
      }),
    [conversationService, settingsService, sshInfo, sshService],
  );

  const { isShellMode, enterShellMode, exitShellMode, handleShellSubmit } = useShellMode({
    session: shellInteractionSession,
    addShellMessage,
    replaceInput,
  });

  const clearConversationAndRefreshBanner = useCallback(async () => {
    onPrintUsage?.();
    await clearConversation();
    setStartupBannerIds(['startup-banner-0']);
    setActiveRestoredStaticMessageIds([]);
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
  // The preview can cost a full outgoing-history build plus a serialization of
  // it (when a warning is actually possible), so it scales with conversation
  // length. Keep it off the keystroke path: debounce the composer text, then
  // evaluate in an effect so the work never sits inside a render. The
  // authoritative check still runs at submit time in ConversationAdmissionWorkflow.
  // An emptied composer flushes immediately so a stale warning never outlives
  // the text it described.
  const hasActiveBackgroundTasks = (backgroundTaskDetails ?? []).some(
    (task) =>
      task.status === 'running' ||
      task.status === 'cancelling' ||
      task.status === 'awaiting_approval' ||
      task.status === 'waiting_for_answer',
  );
  const isOverallBusy = isProcessing || hasActiveBackgroundTasks;

  const grokCreditUsage = useGrokCreditUsage(settingsService, isOverallBusy);
  const openCodeGoUsage = useOpenCodeGoUsage(settingsService, isOverallBusy);

  const previewInput = useDebouncedValue(input, LARGE_UNCACHED_PREVIEW_DEBOUNCE_MS, (value) => value === '');
  const [largeUncachedPreview, setLargeUncachedPreview] = useState<LargeUncachedInputDecision | null>(null);
  useEffect(() => {
    if (!previewInput || mode !== 'text' || previewInput.startsWith('/') || isProcessing) {
      setLargeUncachedPreview(null);
      return;
    }
    const preview = conversationService.previewLargeUncachedInput({ text: previewInput }, Date.now());
    setLargeUncachedPreview(preview.action === 'warn' ? preview : null);
  }, [conversationService, previewInput, mode, isProcessing]);
  // Drop the advisory on the same render that empties the composer / leaves text
  // mode or starts processing; don't wait a frame for the effect to clear a stale warn.
  const largeUncachedWarning =
    !previewInput || mode !== 'text' || previewInput.startsWith('/') || isProcessing ? null : largeUncachedPreview;

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

  const [pendingModeSwitch, setPendingModeSwitch] = useState<PendingModeSwitch | null>(null);

  const handleModeSwitchConfirm = useCallback(async () => {
    if (!pendingModeSwitch) return;
    const { modeKey, modeLabel, targetValue, enabledDetail } = pendingModeSwitch;
    setPendingModeSwitch(null);
    await clearConversationAndRefreshBanner();
    if (targetValue) {
      for (const key of EXCLUSIVE_MODE_KEYS) {
        if (key !== modeKey && settingsService.get(key)) {
          settingsService.set(key, false);
          applyRuntimeSetting(key, false);
        }
      }
    }
    settingsService.set(modeKey, targetValue);
    applyRuntimeSetting(modeKey, targetValue);
    addSystemMessage('Welcome to term²! Type a message to start chatting.');
    addSystemMessage(`${modeLabel} mode ${targetValue ? `enabled${enabledDetail ?? ''}` : 'disabled'}`);
  }, [pendingModeSwitch, clearConversationAndRefreshBanner, settingsService, applyRuntimeSetting, addSystemMessage]);

  const handleModeSwitchDecline = useCallback(() => {
    setPendingModeSwitch(null);
  }, []);

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

  const resumeProjectPath = sshInfo?.remoteDir ?? process.cwd();
  const resumeSshHost = sshInfo?.host;
  const listSavedConversations = useCallback<() => ConversationListEntry[]>(
    () => listConversations(resumeProjectPath, resumeSshHost).slice(0, 10),
    [resumeProjectPath, resumeSshHost],
  );

  const resumeConversation = useCallback(
    async (target?: string) => {
      let restored: RestoredState | null = null;
      if (target) {
        const result = loadConversationForProject(target, resumeProjectPath, resumeSshHost);
        if (result.status === 'project_mismatch') {
          addSystemMessage(`Conversation ${target} belongs to a different project.`);
          return;
        }
        if (result.status === 'unreadable') {
          addSystemMessage(`Conversation ${target} could not be read.`);
          return;
        }
        restored = result.status === 'loaded' ? result.conversation : null;
      } else {
        restored = loadLastConversation(resumeProjectPath, resumeSshHost);
      }

      if (!restored) {
        addSystemMessage(`No conversation found to resume (${target ?? 'last'}).`);
        return;
      }

      if (restored.id !== sessionId) {
        const lock = isConversationLocked(restored.id);
        if (lock?.status === 'held') {
          addSystemMessage(
            `Conversation ${restored.id} is already open in another terminal (pid ${lock.pid}). Close it first or use the CLI --fork option.`,
          );
          return;
        }
        if (lock?.status === 'corrupt') {
          addSystemMessage(`Conversation ${restored.id} has a corrupt lockfile and cannot be resumed here.`);
          return;
        }
      }

      try {
        if (restored.id !== sessionId) {
          onRotateWriter?.(restored.id, restored.createdAt);
        }
        conversationService.resetWithNewId(restored.id);

        const mode = restored.appMode
          ? normalizeAppModes({
              orchestratorMode: Boolean(restored.appMode.orchestratorMode),
              liteMode: restored.appMode.liteMode,
              planMode: restored.appMode.planMode,
              mentorMode: restored.appMode.mentorMode,
            })
          : undefined;
        const changes = [
          ...(restored.model ? [{ key: 'agent.model', value: restored.model, persistence: 'runtime' as const }] : []),
          ...(restored.provider
            ? [{ key: 'agent.provider', value: restored.provider, persistence: 'runtime' as const }]
            : []),
          ...(restored.reasoningEffort &&
          ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(restored.reasoningEffort)
            ? [{ key: 'agent.reasoningEffort', value: restored.reasoningEffort, persistence: 'runtime' as const }]
            : []),
          ...(mode
            ? [
                { key: 'app.orchestratorMode', value: mode.orchestratorMode, persistence: 'runtime' as const },
                { key: 'app.liteMode', value: mode.liteMode, persistence: 'runtime' as const },
                { key: 'app.planMode', value: mode.planMode, persistence: 'runtime' as const },
                { key: 'app.mentorMode', value: mode.mentorMode, persistence: 'runtime' as const },
              ]
            : []),
        ];
        configurationService.apply(changes);

        const savedProviderMatches = !restored.provider || restored.provider === settingsService.get('agent.provider');
        const savedModelMatches = !restored.model || restored.model === settingsService.get('agent.model');
        restoreConversation({
          ...restored,
          previousResponseId: savedProviderMatches && savedModelMatches ? restored.previousResponseId : null,
        });
        setSessionId(restored.id);
        onSessionIdChange?.(restored.id, restored.createdAt);
        setActiveRestoredStaticMessageIds(restored.messages.map((message) => message.id));
        redrawMessageList();
        for (const warning of restored.replayWarnings) {
          addSystemMessage(`Conversation replay: ${warning}`);
        }
        addSystemMessage(`Resumed conversation: ${restored.id}`);
      } catch (error: unknown) {
        addSystemMessage(`Failed to resume conversation: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [
      addSystemMessage,
      configurationService,
      conversationService,
      onRotateWriter,
      onSessionIdChange,
      redrawMessageList,
      restoreConversation,
      resumeProjectPath,
      resumeSshHost,
      sessionId,
      settingsService,
    ],
  );

  // Resize redraw: Ink's <Static> renders committed messages once and never
  // re-renders them, so old messages retain their old width after a terminal
  // resize. When the terminal resizes, clear the visible screen and remount
  // MessageList (via epoch bump) to re-render everything at the new width.
  //
  // Gate on !isProcessing to avoid clearing while Ink's log-update is
  // diff-updating the live region mid-stream, which causes visual artifacts.
  // A settled debounce (300ms of quiet after the last resize event) coalesces
  // resize storms from tmux pane drags or window snaps.
  const pendingResizeRedrawRef = useRef(false);
  const isProcessingRef = useRef(isProcessing);
  isProcessingRef.current = isProcessing;

  useEffect(() => {
    // Guard: test mocks may not provide EventEmitter methods on stdout.
    if (
      typeof (stdout as unknown as { on?: unknown }).on !== 'function' ||
      typeof (stdout as unknown as { off?: unknown }).off !== 'function'
    )
      return;
    const emitter = stdout as unknown as {
      on: (e: string, fn: () => void) => void;
      off: (e: string, fn: () => void) => void;
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (isProcessingRef.current) {
          pendingResizeRedrawRef.current = true;
          return;
        }
        clearVisibleForResize(stdout);
        setMessageListEpoch((epoch) => epoch + 1);
      }, RESIZE_SETTLED_MS);
    };
    emitter.on('resize', handleResize);
    return () => {
      emitter.off('resize', handleResize);
      if (timer !== null) clearTimeout(timer);
    };
  }, [stdout]);

  // When processing ends and a resize redraw was deferred, apply it now.
  useEffect(() => {
    if (isProcessing || !pendingResizeRedrawRef.current) return;
    pendingResizeRedrawRef.current = false;
    clearVisibleForResize(stdout);
    setMessageListEpoch((epoch) => epoch + 1);
  }, [isProcessing, stdout]);

  const getSessionUsage = useCallback(() => {
    const tokenUsage = formatSessionUsageBreakdown(sessionUsage.get(), getSubagentUsage());
    const modelUsage = formatModelUsageBreakdown(sessionCost.getModelUsageBreakdown());
    const summary = getCostSummary();
    if (!summary || summary.state === 'unavailable') {
      return modelUsage ? `${tokenUsage}\n${modelUsage}` : tokenUsage;
    }

    const costLabel = summary.state === 'exact' ? 'Cost' : 'Estimated cost';
    const costAmount = `${formatUsdMicros(summary.knownUsdMicros)}${summary.state === 'partial' ? '+' : ''}`;
    const lowerBound = summary.state === 'partial' ? ' (lower bound)' : '';
    const costUsage = `${costLabel}: ${costAmount}${lowerBound} (${summary.pricedRequests} priced, ${summary.unpricedRequests} unpriced requests)`;
    return [tokenUsage, modelUsage, costUsage].filter(Boolean).join('\n');
  }, [getCostSummary, getSubagentUsage, sessionCost, sessionUsage]);

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

  const openCopyMenu = useCallback(
    (selections: CopySelection[]) => {
      controller.closeAll();
      controller.open({ kind: 'copy', items: selections }, { buffer: { type: 'clear' } });
    },
    [controller],
  );

  const handleCopySelection = useCallback(
    (selection: CopySelection) => {
      void copyToClipboard(selection.text)
        .then(() => {
          addSystemMessage(`Copied ${selection.label.toLowerCase()} to the clipboard.`);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          addSystemMessage(`Failed to copy to clipboard: ${message}`);
        });
    },
    [addSystemMessage],
  );

  const { slashCommands, cycleAppModes } = useAppCommands({
    settingsService,
    addSystemMessage,
    applyRuntimeSetting,
    replaceInput,
    clearConversation: clearConversationAndRefreshBanner,
    getSessionUsage,
    refreshProviderUsage: () => {
      grokCreditUsage.refresh();
      openCodeGoUsage.refresh();
    },
    exit: exitWithUsage,
    messages,
    setModel,
    getRewindItems: openRewindPickerItems,
    rewindToTarget: (item) => rewindToTarget(item.targetId, item.uiIndex),
    restoreTurnToInput,
    retryLastToolOutput,
    compactContext,
    onRewind: redrawMessageList,
    openRewindMenu,
    openProvidersMenu: () => {
      controller.closeAll();
      controller.open({ kind: 'providers' });
    },
    openCopyMenu,
    onHandoff: handoff.startHandoff,
    sendUserMessage,
    skillsService: skillsService ?? ({ getAvailableSkills: () => [] } as unknown as SkillsService),
    onSkillSelected: handleSkillSelected,
    requestModeSwitchConfirm: setPendingModeSwitch,
    turnInFlight: isProcessing,
    listConversations: listSavedConversations,
    resumeConversation,
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

  const handleTypeAnswer = useCallback(
    (initialAnswer?: string) => {
      if (initialAnswer !== undefined) {
        // Seed the composer with the selected answer and a separator so the
        // next characters become an appended note rather than joining words.
        setInput(`${initialAnswer} `);
      }
      onTypeAnswer();
    },
    [onTypeAnswer, setInput],
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
    // A check-in has no tool to deny and its decision path discards any reason.
    // Asking "Why?" here strands the user: the composer refuses an empty
    // submit, so Stop could only be reached by typing text nothing reads.
    if (pendingApproval?.checkIn) {
      void handleApprovalDecision('n', undefined);
      return;
    }
    setWaitingForRejectionReason(true);
  }, [
    backgroundApprovalEntry,
    backgroundApprovalState.revision,
    handleApprovalDecision,
    pendingApproval,
    resolveBackgroundSubagentApproval,
    sandboxPromptRequest,
    setWaitingForRejectionReason,
  ]);

  const handleCancelApproval = useCallback(() => {
    if (sandboxPromptRequest) {
      sandboxApprovalCoordinatorRef.current?.resolve(sandboxPromptRequest, 'deny');
      return;
    }
    if (backgroundApprovalEntry) {
      resolveBackgroundSubagentApproval({
        revision: backgroundApprovalState.revision,
        entry: backgroundApprovalEntry,
        decision: { answer: 'no', rejectionReason: undefined },
      });
      return;
    }
    if (pendingApproval?.toolName === 'ask_user') {
      // Graceful cancel: resolve the question with no answer while keeping the
      // turn's record (see use-conversation cancelAskUser).
      cancelAskUser();
      return;
    }
    // Escape in a regular approval prompt means “cancel/interrupt the turn”:
    // abort the run loop and drop the pending tool call.
    stopProcessing();
  }, [
    sandboxPromptRequest,
    backgroundApprovalEntry,
    backgroundApprovalState.revision,
    resolveBackgroundSubagentApproval,
    cancelAskUser,
    pendingApproval,
    stopProcessing,
  ]);

  const submitBridgedRejectionReason = useCallback(
    async (reason: string) => {
      if (backgroundApprovalEntry) {
        resolveBackgroundSubagentApproval({
          revision: backgroundApprovalState.revision,
          entry: backgroundApprovalEntry,
          decision: { answer: 'no', rejectionReason: reason },
        });
        setWaitingForRejectionReason(false);
        return;
      }
      await handleApprovalDecision('n', reason);
    },
    [
      backgroundApprovalEntry,
      backgroundApprovalState.revision,
      handleApprovalDecision,
      resolveBackgroundSubagentApproval,
      setWaitingForRejectionReason,
    ],
  );

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
    pendingModeSwitch,
    pendingSurgeTurn,
    pendingLargeUncachedTurn,
    waitingForApproval: effectiveWaitingForApproval,
    waitingForRejectionReason: effectiveWaitingForRejectionReason,
    waitingForAskUserAnswer: effectiveWaitingForAskUserAnswer,
    pendingApproval: effectivePendingApproval,
    queuePaused,
    backgroundTaskManagerOpen,
    firstRunSetupActive: firstRunSetup.active,
    isProcessing: effectiveIsProcessing,
    menuOpen,
  });

  useEffect(() => {
    setTerminalTitle(buildTerminalTitleLabel(terminalTitleBase, isOverallBusy));
  }, [isOverallBusy, terminalTitleBase]);

  useEffect(() => {
    publishHarnessInputState({ owner: inputOwner.kind, processing: effectiveIsProcessing });
  }, [effectiveIsProcessing, inputOwner.kind]);

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

  const { interruptConfirmVisible, markRejectionReasonInputReady } = useAppKeyboardShortcuts({
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
    cycleAppModes,
    replaceInput,
    onSkillActivationCancelled: () => addSystemMessage('Skill activation cancelled.'),
    approvalShortcutsEnabled:
      effectivePendingApproval?.toolName !== TOOL_NAME_ASK_USER && !effectivePendingApproval?.dockerHostControl,
    approvalShortcutApproveAnswer:
      sandboxPromptRequest || effectivePendingApproval?.deniedRead ? 'allow-once' : undefined,
    onApprove: handleApprove,
    onReject: handleReject,
    submitRejectionReason: submitBridgedRejectionReason,
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
    const value = turn.text;
    const hasImages = Boolean(turn.images?.length);
    if (!hasUserTurnContent(turn) && handoff.handoffState?.stage !== 'entering_message') return;

    if (isShellMode && !hasImages) {
      await handleShellSubmit(value);
      return;
    }

    if (await submitConversationTurn(turn)) {
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
            restoredStaticMessageIds={activeRestoredStaticMessageIds}
            turnPaused={effectiveWaitingForApproval}
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
            onShellModeEnter={enterShellMode}
            onShellModeExit={exitShellMode}
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
            backgroundTaskDetails={backgroundTaskDetails}
            backgroundTaskDetailsNow={backgroundTaskDetailsNow}
            listBackgroundTaskDetails={listBackgroundTaskDetails}
            getBackgroundTaskDetails={getBackgroundTaskDetails}
            stopBackgroundTask={stopBackgroundTask}
            getForegroundTaskTransferCandidate={getForegroundTaskTransferCandidate}
            moveForegroundTaskToBackground={moveForegroundTaskToBackground}
            listForegroundTaskTransferCandidates={listForegroundTaskTransferCandidates}
            backgroundTaskManagerOpen={backgroundTaskManagerOpen}
            onBackgroundTaskManagerOpenChange={setBackgroundTaskManagerOpen}
            backgroundApprovalPendingCount={backgroundApprovalState.pendingCount}
            onRetractQueuedMessage={retractPendingSubmission}
            onEditQueuedMessage={editPendingSubmission}
            onSubmit={handleSubmit}
            onRejectionReasonInputReady={markRejectionReasonInputReady}
            slashCommands={slashCommands}
            skillsService={skillsService}
            settingsService={settingsService}
            loggingService={loggingService}
            historyService={historyService}
            onApprove={handleApprove}
            onReject={handleReject}
            onCancel={handleCancelApproval}
            onTypeAnswer={handleTypeAnswer}
            onNavigateQuestion={handleNavigateQuestion}
            sshInfo={sshInfo}
            lastCodexRateLimit={lastCodexRateLimit}
            runBudgetNotice={runBudgetNotice}
            grokCreditUsage={grokCreditUsage.usage}
            openCodeGoUsage={openCodeGoUsage.usage}
            staticCommitBlocker={staticCommitBlocker}
            firstRunSetup={firstRunSetup}
            onProviderSelected={firstRunSetup.active ? firstRunSetup.onProviderSelected : undefined}
            onUnavailableModelSelected={firstRunSetup.requestSetup}
            onSkillSelected={handleSkillSelected}
            onCopySelection={handleCopySelection}
            listConversations={listSavedConversations}
            resumeConversation={resumeConversation}
            onSettingChange={handleSettingChange}
            onSystemMessage={addSystemMessage}
            handoffState={handoff.handoffState}
            onHandoffConfirm={handoff.confirmHandoff}
            onHandoffDecline={handoff.declineHandoff}
            onHandoffCancel={handoff.cancelHandoff}
            onStandardModeConfirm={handoff.confirmStandardMode}
            onStandardModeDecline={handoff.declineStandardMode}
            pendingModeSwitch={pendingModeSwitch}
            onModeSwitchConfirm={handleModeSwitchConfirm}
            onModeSwitchDecline={handleModeSwitchDecline}
            largeUncachedWarning={largeUncachedWarning}
            pendingLargeUncachedTurn={pendingLargeUncachedTurn}
            pendingLargeUncachedTokens={pendingLargeUncachedTokens}
            onLargeUncachedApprove={handleLargeUncachedApprove}
            onLargeUncachedDecline={handleLargeUncachedDecline}
            pendingSurgeTurn={pendingSurgeTurn}
            pendingSurgeReason={pendingSurgeReason}
            onSurgeApprove={handleSurgeApprove}
            onSurgeDecline={handleSurgeDecline}
          />
        </Box>
      </Box>
    </ErrorBoundary>
  );
};

export default App;
