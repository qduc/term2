import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInputActions, useInputState } from './context/InputContext.js';
import { parseModelProviderArg } from './utils/model-provider-arg.js';

import { Box, useApp, useInput, useStdout } from 'ink';
import { useConversation } from './hooks/use-conversation.js';
import MessageList, { MESSAGE_HORIZONTAL_PADDING } from './components/MessageList.js';
import BottomArea from './components/BottomArea.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import type { ConversationService } from './services/conversation-service.js';
import type { SettingsService } from './services/settings-service.js';
import type { HistoryService } from './services/history-service.js';
import type { LoggingService } from './services/logging-service.js';
import { ISSHService } from './services/service-interfaces.js';
import { useSetting } from './hooks/use-setting.js';
import { parseInput } from './utils/input-parser.js';
import { useRuntimeSettings } from './hooks/use-runtime-settings.js';
import { useShellMode, SSHInfo } from './hooks/use-shell-mode.js';
import { useAppCommands } from './hooks/use-app-commands.js';
import { hasUserTurnContent, type UserTurn } from './types/user-turn.js';
import { createUsageAccumulator, formatSessionUsageBreakdown, type UsageAccumulator } from './utils/token-usage.js';
import type { Message } from './hooks/use-conversation.js';
import type { UndoItem } from './hooks/use-undo-selection.js';
import { resolveSlashCommand } from './slash-commands.js';

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
  logWriter?: { append: (event: any) => void };
  onRotateWriter?: (newSessionId: string) => void;
  generateId: () => string;
  onSessionIdChange?: (newId: string, createdAt: string) => void;
}

export const appendStartupBannerId = (ids: string[]): string[] => [...ids, `startup-banner-${ids.length}`];

export const hasConversationContent = (messages: Message[]): boolean => messages.some((msg) => msg.sender !== 'system');

export const TERMINAL_REDRAW_CLEAR = '\u001B[2J\u001B[3J\u001B[H';

type TerminalWriter = {
  write: (value: string) => unknown;
};

export const clearTerminalForRedraw = (stdout: TerminalWriter): void => {
  stdout.write(TERMINAL_REDRAW_CLEAR);
};

type ScheduleCallback = (callback: () => void, delay: number) => unknown;

export const scheduleExitSideEffects = (
  _messages: Message[],
  onExitUsage?: () => void,
  schedule: ScheduleCallback = setTimeout,
): void => {
  schedule(() => {
    onExitUsage?.();
  }, 0);
};

export type HandoffStage = 'confirm_model' | 'selecting_model';
export interface HandoffState {
  capturedText: string;
  stage: HandoffStage;
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
  logWriter,
  onRotateWriter,
  generateId,
  onSessionIdChange,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { setInput, setMode, setTriggerIndex } = useInputActions();
  const { mode } = useInputState();
  const [handoffState, setHandoffState] = useState<HandoffState | null>(null);
  const undoMenuRef = useRef<{ open: (items: UndoItem[]) => void } | null>(null);
  const [messageListEpoch, setMessageListEpoch] = useState(0);
  const [startupBannerIds, setStartupBannerIds] = useState(['startup-banner-0']);
  const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;
  const sessionUsage = useMemo(() => usageAccumulator ?? createUsageAccumulator(), [usageAccumulator]);
  const subagentUsage = useMemo(() => subagentUsageAccumulator ?? createUsageAccumulator(), [subagentUsageAccumulator]);

  const [sessionId, setSessionId] = useState(initialSessionId);
  const handleClearConversationRef = useRef<(() => Promise<void>) | null>(null);

  const {
    messages,
    lastUsage,
    lastCodexRateLimit,
    pendingApproval,
    waitingForApproval,
    waitingForRejectionReason,
    setWaitingForRejectionReason,
    isProcessing,
    sendUserMessage,
    handleApprovalDecision,
    clearConversation,
    stopProcessing,
    undoLastUserMessage,
    getUserMessages,
    undoToUserMessage,
    setModel,
    setReasoningEffort,
    addSystemMessage,
    setTemperature,
    addShellMessage,
    getSubagentUsage,
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
  });

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

  useEffect(() => {
    conversationService.setRetryCallback(() => addSystemMessage('Retrying due to upstream error...'));
  }, [conversationService, addSystemMessage]);

  useEffect(() => {
    if (handoffState?.stage === 'selecting_model' && mode === 'text') {
      setHandoffState(null);
      setInput('');
      void sendUserMessage({ text: `Implement this:\n\n${handoffState.capturedText}` });
    }
  }, [mode, sendUserMessage, setInput, handoffState]);

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
    setInput,
    liteMode,
    sshInfo,
    sshService,
  });

  const refreshStartupBanner = useCallback(() => {
    setStartupBannerIds(appendStartupBannerId);
  }, []);

  const clearConversationAndRefreshBanner = useCallback(async () => {
    onPrintUsage?.();
    await clearConversation();
    refreshStartupBanner();
  }, [clearConversation, onPrintUsage, refreshStartupBanner]);

  const redrawMessageList = useCallback(() => {
    clearTerminalForRedraw(stdout);
    setMessageListEpoch((epoch) => epoch + 1);
  }, [stdout]);

  const getSessionUsage = useCallback(
    () => formatSessionUsageBreakdown(sessionUsage.get(), getSubagentUsage()),
    [sessionUsage, getSubagentUsage],
  );

  const exitWithUsage = useCallback(() => {
    exit();
    onExitUsage?.();
  }, [exit, onExitUsage]);

  const handleHandoffConfirm = useCallback(async () => {
    await clearConversationAndRefreshBanner();
    setHandoffState((prev) => (prev ? { ...prev, stage: 'selecting_model' } : null));
    setInput('/model ');
    setMode('model_selection');
    setTriggerIndex('/model '.length);
  }, [clearConversationAndRefreshBanner, setInput, setMode, setTriggerIndex]);

  const handleHandoffDecline = useCallback(async () => {
    const text = handoffState?.capturedText;
    await clearConversationAndRefreshBanner();
    setHandoffState(null);
    setInput('');
    if (text) {
      await sendUserMessage({ text: `Implement this:\n\n${text}` });
    }
  }, [handoffState, clearConversationAndRefreshBanner, sendUserMessage, setInput]);

  const handleHandoffCancel = useCallback(() => {
    setHandoffState(null);
    setInput('');
    addSystemMessage('Handoff cancelled');
  }, [addSystemMessage, setInput]);

  const handleHandoff = useCallback((capturedText: string) => {
    setHandoffState({ capturedText, stage: 'confirm_model' });
  }, []);

  const { slashCommands, cycleAppModes } = useAppCommands({
    settingsService,
    addSystemMessage,
    applyRuntimeSetting,
    setInput,
    clearConversation: clearConversationAndRefreshBanner,
    getSessionUsage,
    exit: exitWithUsage,
    messages,
    setModel,
    undoLastUserMessage,
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
    onHandoff: handleHandoff,
  });

  const handleUndoSelect = useCallback(
    (item: UndoItem) => {
      const text = undoToUserMessage(item.uiIndex);
      if (text !== null) {
        redrawMessageList();
        setInput(text);
      }
    },
    [undoToUserMessage, redrawMessageList, setInput],
  );

  const hasConversationHistory = useMemo(() => hasConversationContent(messages), [messages]);

  // Handle Ctrl+C to exit immediately
  useInput((_input: string, key) => {
    if (key.ctrl && _input === 'c') {
      exitWithUsage();
    }
  });

  // Handle Esc to stop processing or cancel rejection reason
  useInput((_input: string, key) => {
    if (key.escape && waitingForRejectionReason) {
      // Cancel rejection reason input and return to approval prompt
      setWaitingForRejectionReason(false);
      setInput('');
      return;
    }

    if (key.escape && (isProcessing || waitingForApproval)) {
      stopProcessing();
      addSystemMessage('Stopped');
      setWaitingForRejectionReason(false);
    }
  });

  const handleApprove = useCallback(async () => {
    await handleApprovalDecision('y');
  }, [handleApprovalDecision]);

  const handleReject = useCallback(() => {
    setWaitingForRejectionReason(true);
  }, [setWaitingForRejectionReason]);

  // Switch between Standard and Plan modes with Shift+Tab
  useInput((input: string, key) => {
    const isShiftTab = (key.shift && key.tab) || input === '\u001b[Z';
    if (!isShiftTab) return;

    if (liteMode) {
      toggleShellMode();
      return;
    }

    cycleAppModes();
  });

  const handleSubmit = async (turn: UserTurn): Promise<void> => {
    const value = turn.text;
    const hasImages = Boolean(turn.images?.length);
    if (!hasUserTurnContent(turn)) return;

    // If waiting for rejection reason, handle it
    if (waitingForRejectionReason) {
      setWaitingForRejectionReason(false);
      setInput('');
      await handleApprovalDecision('n', value);
      return;
    }

    // If waiting for approval, ignore text input (handled by useInput)
    if (waitingForApproval) return;

    if (liteMode && isShellMode && !hasImages) {
      await handleShellSubmit(value);
      return;
    }

    // Handoff flow interception
    if (handoffState) {
      if (handoffState.stage === 'selecting_model') {
        // Model was selected from popup → model text submitted as message
        const parsedInput = parseInput(value);
        const modelArg = parsedInput.type === 'slash-command' ? parsedInput.args : value;
        const { modelId, provider } = parseModelProviderArg(modelArg);
        if (modelId) {
          settingsService.set('agent.model', modelId);
          if (provider) {
            settingsService.set('agent.provider', provider);
            applyRuntimeSetting('agent.provider', provider);
          }
          applyRuntimeSetting('agent.model', modelId);
          setModel(modelId);
        }
        const text = handoffState.capturedText;
        setHandoffState(null);
        setInput('');
        await sendUserMessage({ text: `Implement this:\n\n${text}` });
        return;
      }
    }

    // Parse the input to determine what to do
    const parsed = parseInput(value);

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
            setInput('');
          }
          return;
        }
        // Command not found, fall through to send as message
        break;
      }

      case 'message':
        // Regular message, send to AI agent
        historyService.addMessage(turn);
        setInput('');
        await sendUserMessage(turn);
        return;
    }

    // Fallback: unknown slash command, send as message
    setInput('');
    await sendUserMessage(turn);
  };

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
          />
        </Box>

        {/* Fixed bottom area for input / status */}
        <Box paddingX={MESSAGE_HORIZONTAL_PADDING}>
          <BottomArea
            pendingApproval={pendingApproval}
            waitingForApproval={waitingForApproval}
            waitingForRejectionReason={waitingForRejectionReason}
            isProcessing={isProcessing}
            isShellMode={isShellMode}
            lastUsage={lastUsage}
            onSubmit={handleSubmit}
            slashCommands={slashCommands}
            hasConversationHistory={hasConversationHistory}
            settingsService={settingsService}
            loggingService={loggingService}
            historyService={historyService}
            onApprove={handleApprove}
            onReject={handleReject}
            sshInfo={sshInfo}
            lastCodexRateLimit={lastCodexRateLimit}
            undoMenuRef={undoMenuRef}
            onUndoSelect={handleUndoSelect}
            onSettingChange={applyRuntimeSetting}
            handoffState={handoffState}
            onHandoffConfirm={handleHandoffConfirm}
            onHandoffDecline={handleHandoffDecline}
            onHandoffCancel={handleHandoffCancel}
          />
        </Box>
      </Box>
    </ErrorBoundary>
  );
};

export default App;
