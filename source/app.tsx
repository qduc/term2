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
import { parseInput } from './utils/input-parser.js';
import { useRuntimeSettings } from './hooks/use-runtime-settings.js';
import { useShellMode, SSHInfo } from './hooks/use-shell-mode.js';
import { useAppCommands } from './hooks/use-app-commands.js';
import { useHandoffFlow } from './hooks/use-handoff-flow.js';
import { usePendingTurnGuards } from './hooks/use-pending-turn-guards.js';
import { useTerminalFocusNotifier } from './hooks/use-terminal-focus-notifier.js';
import { useAppKeyboardShortcuts } from './hooks/use-app-keyboard-shortcuts.js';
import { hasUserTurnContent, type UserTurn } from './types/user-turn.js';
import type { Message } from './types/message.js';
import { createUsageAccumulator, formatSessionUsageBreakdown, type UsageAccumulator } from './utils/ai/token-usage.js';
import type { UndoItem } from './hooks/use-undo-selection.js';
import { resolveSlashCommand } from './slash-commands.js';
import type { SkillsService, SkillInfo } from './services/skills/skills-service.js';
import { buildTerminalTitleLabel, setTerminalTitle } from './utils/output/terminal-title.js';
import {
  registerSandboxNetworkApprovalHandler,
  type SandboxNetworkAccessRequest,
} from './utils/shell/sandbox/sandbox-network-approval.js';

export {
  appendStartupBannerId,
  clearTerminalForRedraw,
  messagesHaveNonSystemContent,
  scheduleExitSideEffects,
  TERMINAL_REDRAW_CLEAR,
} from './app-helpers.js';

interface AppProps {
  conversationService: ConversationService;
  settingsService: SettingsService;
  historyService: HistoryService;
  loggingService: LoggingService;
  sshInfo?: SSHInfo;
  sshService?: ISSHService;
  usageAccumulator?: UsageAccumulator;
  subagentUsageAccumulator?: UsageAccumulator;
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
  const { setInput, replaceInput, setMode, setTriggerIndex, setImages, setInputAndCursor } = useInputActions();
  const { input, mode, images } = useInputState();
  const undoMenuRef = useRef<{ open: (items: UndoItem[]) => void } | null>(null);
  const providersMenuRef = useRef<{ open: () => void } | null>(null);
  const [messageListEpoch, setMessageListEpoch] = useState(0);
  const [startupBannerIds, setStartupBannerIds] = useState(['startup-banner-0']);
  const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;
  const displayMode = useSetting<string>(settingsService, 'ui.displayMode') ?? 'standard';
  const sessionUsage = useMemo(() => usageAccumulator ?? createUsageAccumulator(), [usageAccumulator]);
  const subagentUsage = useMemo(() => subagentUsageAccumulator ?? createUsageAccumulator(), [subagentUsageAccumulator]);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const handleClearConversationRef = useRef<(() => Promise<void>) | null>(null);
  const pendingSkillRef = useRef<SkillInfo | null>(null);
  const [sandboxPromptRequest, setSandboxPromptRequest] = useState<SandboxNetworkAccessRequest | null>(null);
  const sandboxPromptQueueRef = useRef<
    Array<{ request: SandboxNetworkAccessRequest; resolve: (allow: boolean) => void }>
  >([]);
  const activeSandboxPromptRef = useRef<{
    request: SandboxNetworkAccessRequest;
    resolve: (allow: boolean) => void;
  } | null>(null);

  const notifier = useTerminalFocusNotifier({ stdout, settingsService, loggingService });

  const showNextSandboxPrompt = useCallback(() => {
    if (activeSandboxPromptRef.current) {
      return;
    }
    const next = sandboxPromptQueueRef.current.shift();
    if (!next) {
      return;
    }
    activeSandboxPromptRef.current = next;
    setSandboxPromptRequest(next.request);
  }, []);

  const resolveSandboxPrompt = useCallback(
    (allow: boolean) => {
      const active = activeSandboxPromptRef.current;
      if (!active) {
        return;
      }
      active.resolve(allow);
      activeSandboxPromptRef.current = null;
      setSandboxPromptRequest(null);
      showNextSandboxPrompt();
    },
    [showNextSandboxPrompt],
  );

  useEffect(() => {
    const unregister = registerSandboxNetworkApprovalHandler(async (request) => {
      return await new Promise<boolean>((resolve) => {
        sandboxPromptQueueRef.current.push({ request, resolve });
        showNextSandboxPrompt();
      });
    });

    return () => {
      unregister();
      const active = activeSandboxPromptRef.current;
      if (active) {
        active.resolve(false);
      }
      activeSandboxPromptRef.current = null;
      setSandboxPromptRequest(null);

      for (const queued of sandboxPromptQueueRef.current) {
        queued.resolve(false);
      }
      sandboxPromptQueueRef.current = [];
    };
  }, [showNextSandboxPrompt]);

  const {
    messages,
    lastUsage,
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
    sendUserMessage,
    submitConversationTurn,
    submitApprovalDecision,
    onTypeAnswer,
    clearConversation,
    stopProcessing,
    undoLastUserMessage,
    retryLastToolOutput,
    getUserMessages,
    undoToUserMessage,
    setModel,
    setReasoningEffort,
    addSystemMessage,
    setTemperature,
    addShellMessage,
    getSubagentUsage,
    goToPreviousQuestion,
    goToNextQuestion,
  } = useConversation({
    conversationService,
    loggingService,
    usageAccumulator: sessionUsage,
    subagentUsageAccumulator: subagentUsage,
    initialMessages,
    sessionId,
    onClear: useCallback(async () => {
      if (handleClearConversationRef.current) {
        await handleClearConversationRef.current();
      }
    }, []),
    settingsService,
    onRestoreInput: setInput,
    logWriter,
    notifier,
  });

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

  const applyRuntimeSetting = useRuntimeSettings({
    setModel,
    setReasoningEffort,
    setTemperature,
    conversationService,
    settingsService,
  });

  const { isShellMode, toggleShellMode, handleShellSubmit } = useShellMode({
    settingsService,
    conversationService,
    addShellMessage,
    replaceInput,
    liteMode,
    sshInfo,
    sshService,
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
    setInputAndCursor,
    setMode,
    setTriggerIndex,
    mode,
    settingsService,
    applyRuntimeSetting,
    setModel,
  });

  const pendingGuards = usePendingTurnGuards({
    input,
    mode,
    images,
    conversationService,
    historyService,
    loggingService,
    sendUserMessage,
    replaceInput,
    setImages,
  });

  const redrawMessageList = useCallback(() => {
    clearTerminalForRedraw(stdout);
    setMessageListEpoch((epoch) => epoch + 1);
  }, [stdout]);

  const getSessionUsage = useCallback(
    () => formatSessionUsageBreakdown(sessionUsage.get(), getSubagentUsage()),
    [sessionUsage, getSubagentUsage],
  );

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
    undoLastUserMessage,
    retryLastToolOutput,
    onUndo: redrawMessageList,
    openUndoMenu: () => {
      const userMessages = getUserMessages().map((m) => ({ uiIndex: m.uiIndex, text: m.text }));
      if (userMessages.length === 0) {
        addSystemMessage('Nothing to undo.');
        return;
      }
      if (undoMenuRef.current) {
        undoMenuRef.current.open(userMessages);
      }
    },
    openProvidersMenu: () => {
      if (providersMenuRef.current) {
        providersMenuRef.current.open();
      }
    },
    onHandoff: handoff.startHandoff,
    sendUserMessage,
    listUserTurns: () => conversationService.listUserTurns(),
    skillsService: skillsService ?? ({ getAvailableSkills: () => [] } as unknown as SkillsService),
    onSkillSelected: handleSkillSelected,
  });

  const handleUndoSelect = useCallback(
    (item: UndoItem) => {
      const text = undoToUserMessage(item.uiIndex);
      if (text !== null) {
        redrawMessageList();
        replaceInput(text);
      }
    },
    [undoToUserMessage, redrawMessageList, replaceInput],
  );

  const handleApprove = useCallback(
    async (answer?: string) => {
      if (sandboxPromptRequest) {
        resolveSandboxPrompt(true);
        return;
      }
      await submitApprovalDecision(answer);
    },
    [sandboxPromptRequest, resolveSandboxPrompt, submitApprovalDecision],
  );

  const handleReject = useCallback(() => {
    if (sandboxPromptRequest) {
      resolveSandboxPrompt(false);
      return;
    }
    setWaitingForRejectionReason(true);
  }, [sandboxPromptRequest, resolveSandboxPrompt, setWaitingForRejectionReason]);

  const effectivePendingApproval =
    sandboxPromptRequest === null
      ? pendingApproval
      : {
          agentName: 'Sandbox',
          toolName: 'sandbox_network_access',
          argumentsText: `Allow network access to ${sandboxPromptRequest.host}${
            sandboxPromptRequest.port == null ? '' : `:${sandboxPromptRequest.port}`
          }?`,
          rawInterruption: sandboxPromptRequest,
        };
  const effectiveWaitingForApproval = sandboxPromptRequest ? true : waitingForApproval;
  const effectiveWaitingForRejectionReason = sandboxPromptRequest ? false : waitingForRejectionReason;
  const effectiveWaitingForAskUserAnswer = sandboxPromptRequest ? false : waitingForAskUserAnswer;
  const effectiveIsProcessing = sandboxPromptRequest ? false : isProcessing;

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

  useAppKeyboardShortcuts({
    exitWithUsage,
    pendingSkillRef,
    waitingForAskUserAnswer: effectiveWaitingForAskUserAnswer,
    setWaitingForAskUserAnswer,
    waitingForRejectionReason: effectiveWaitingForRejectionReason,
    setWaitingForRejectionReason,
    isProcessing: effectiveIsProcessing,
    waitingForApproval: effectiveWaitingForApproval,
    stopProcessing,
    handoffState: handoff.handoffState,
    cancelHandoff: handoff.cancelHandoff,
    pendingLargeUncachedTurn: pendingGuards.pendingLargeUncachedTurn,
    liteMode,
    toggleShellMode,
    cycleAppModes,
    replaceInput,
    onSkillActivationCancelled: () => addSystemMessage('Skill activation cancelled.'),
  });

  const handleSubmit = async (turn: UserTurn): Promise<void> => {
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
        // Find matching command
        const command = resolveSlashCommand(slashCommands, parsed.commandName);
        if (command) {
          // Execute the command
          const shouldClearInput = command.action(parsed.args || undefined);

          // Clear input unless command returned false
          if (shouldClearInput !== false) {
            replaceInput('');
          }
          return;
        }
        // Command not found, fall through to send as message
        break;
      }

      case 'message':
        await pendingGuards.sendGuardedTurn(attachPendingSkill(turn));
        return;
    }

    await pendingGuards.sendGuardedTurn(attachPendingSkill(turn));
  };

  const handleSettingChange = useCallback(
    (key: string, value: any) => {
      applyRuntimeSetting(key, value);
      if (handoff.handoffState?.stage === 'selecting_effort' && key === 'agent.reasoningEffort') {
        void handoff.completeHandoffWithEffort(value);
      }
    },
    [applyRuntimeSetting, handoff],
  );

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
            thinkingStartedAt={thinkingStartedAt}
            toolCallStreamingInfo={toolCallStreamingInfo}
            isShellMode={isShellMode}
            lastUsage={lastUsage}
            onSubmit={handleSubmit}
            slashCommands={slashCommands}
            skillsService={skillsService}
            settingsService={settingsService}
            loggingService={loggingService}
            historyService={historyService}
            onApprove={handleApprove}
            onReject={handleReject}
            onTypeAnswer={onTypeAnswer}
            onNavigateQuestion={handleNavigateQuestion}
            sshInfo={sshInfo}
            lastCodexRateLimit={lastCodexRateLimit}
            staticCommitBlocker={staticCommitBlocker}
            undoMenuRef={undoMenuRef}
            onUndoSelect={handleUndoSelect}
            providersMenuRef={providersMenuRef}
            onSettingChange={handleSettingChange}
            onSystemMessage={addSystemMessage}
            handoffState={handoff.handoffState}
            onHandoffConfirm={handoff.confirmHandoff}
            onHandoffDecline={handoff.declineHandoff}
            onHandoffCancel={handoff.cancelHandoff}
            onStandardModeConfirm={handoff.confirmStandardMode}
            onStandardModeDecline={handoff.declineStandardMode}
            largeUncachedWarning={pendingGuards.largeUncachedWarning}
            pendingLargeUncachedTurn={pendingGuards.pendingLargeUncachedTurn}
            pendingLargeUncachedTokens={pendingGuards.pendingLargeUncachedTokens}
            onLargeUncachedApprove={pendingGuards.handleLargeUncachedApprove}
            onLargeUncachedDecline={pendingGuards.handleLargeUncachedDecline}
            pendingSurgeTurn={pendingGuards.pendingSurgeTurn}
            pendingSurgeReason={pendingGuards.pendingSurgeReason}
            onSurgeApprove={pendingGuards.handleSurgeApprove}
            onSurgeDecline={pendingGuards.handleSurgeDecline}
            onSlashTabComplete={(command) => {
              if (command.name === 'undo') {
                const userMessages = getUserMessages().map((m) => ({ uiIndex: m.uiIndex, text: m.text }));
                if (userMessages.length === 0) {
                  addSystemMessage('Nothing to undo.');
                  return true;
                }
                if (undoMenuRef.current) {
                  undoMenuRef.current.open(userMessages);
                }
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
