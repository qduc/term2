import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInputActions } from './context/InputContext.js';

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
  onPrintUsage?: () => void;
  onExitUsage?: () => void;
  sessionId: string;
  initialMessages?: Message[];
  onSaveConversation: (messages: Message[]) => Promise<void>;
  onMessagesChange: (messages: Message[]) => void;
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
  messages: Message[],
  onSaveConversation: (messages: Message[]) => Promise<void>,
  onExitUsage?: () => void,
  schedule: ScheduleCallback = setTimeout,
): void => {
  schedule(() => {
    if (hasConversationContent(messages)) {
      void onSaveConversation(messages).finally(() => {
        onExitUsage?.();
      });
    } else {
      onExitUsage?.();
    }
  }, 0);
};

const App: FC<AppProps> = ({
  conversationService,
  settingsService,
  historyService,
  loggingService,
  sshInfo,
  sshService,
  usageAccumulator,
  onPrintUsage,
  onExitUsage,
  sessionId: _sessionId,
  initialMessages = [],
  onSaveConversation,
  onMessagesChange,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { setInput } = useInputActions();
  const undoMenuRef = useRef<{ open: (items: UndoItem[]) => void } | null>(null);
  const [messageListEpoch, setMessageListEpoch] = useState(0);
  const [startupBannerIds, setStartupBannerIds] = useState(['startup-banner-0']);
  const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;
  const sessionUsage = useMemo(() => usageAccumulator ?? createUsageAccumulator(), [usageAccumulator]);
  const subagentUsage = useMemo(() => createUsageAccumulator(), []);

  const {
    messages,
    lastUsage,
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
  });

  // Sync messages to parent for SIGINT save-on-exit
  useEffect(() => {
    onMessagesChange(messages);
  }, [messages, onMessagesChange]);

  useEffect(() => {
    conversationService.setRetryCallback(() => addSystemMessage('Retrying due to upstream error...'));
  }, [conversationService, addSystemMessage]);

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

  const clearConversationAndRefreshBanner = useCallback(() => {
    onPrintUsage?.();
    clearConversation();
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
    scheduleExitSideEffects(messages, onSaveConversation, onExitUsage);
  }, [exit, onExitUsage, onSaveConversation, messages]);

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

  // Toggle edit mode with Shift+Tab for quick approval profile switching
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
            undoMenuRef={undoMenuRef}
            onUndoSelect={handleUndoSelect}
          />
        </Box>
      </Box>
    </ErrorBoundary>
  );
};

export default App;
