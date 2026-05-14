import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { useInputActions } from './context/InputContext.js';

import { Box, useApp, useInput } from 'ink';
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

interface AppProps {
  conversationService: ConversationService;
  settingsService: SettingsService;
  historyService: HistoryService;
  loggingService: LoggingService;
  sshInfo?: SSHInfo;
  sshService?: ISSHService;
}

export const appendStartupBannerId = (ids: string[]): string[] => [...ids, `startup-banner-${ids.length}`];

const App: FC<AppProps> = ({
  conversationService,
  settingsService,
  historyService,
  loggingService,
  sshInfo,
  sshService,
}) => {
  const { exit } = useApp();
  const { setInput } = useInputActions();
  const [startupBannerIds, setStartupBannerIds] = useState(['startup-banner-0']);
  const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;

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
    setModel,
    setReasoningEffort,
    addSystemMessage,
    setTemperature,
    addShellMessage,
  } = useConversation({ conversationService, loggingService });

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
    clearConversation();
    refreshStartupBanner();
  }, [clearConversation, refreshStartupBanner]);

  const { slashCommands, toggleEditMode } = useAppCommands({
    settingsService,
    addSystemMessage,
    applyRuntimeSetting,
    setInput,
    clearConversation: clearConversationAndRefreshBanner,
    exit,
    messages,
    setModel,
  });

  const hasConversationHistory = useMemo(() => messages.some((msg) => msg.sender !== 'system'), [messages]);

  // Handle Ctrl+C to exit immediately
  useInput((_input: string, key) => {
    if (key.ctrl && _input === 'c') {
      exit();
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

    toggleEditMode();
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
        const command = slashCommands.find((cmd) => cmd.name === parsed.commandName);
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
        if (value.trim()) {
          historyService.addMessage(value);
        }
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
          />
        </Box>
      </Box>
    </ErrorBoundary>
  );
};

export default App;
