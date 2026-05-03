import React, { FC, useCallback, useEffect } from 'react';
import { useInputActions } from './context/InputContext.js';

import { Box, useApp, useInput } from 'ink';
import { useConversation } from './hooks/use-conversation.js';
import Banner from './components/Banner.js';
import MessageList from './components/MessageList.js';
import LiveResponse from './components/LiveResponse.js';
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

interface AppProps {
  conversationService: ConversationService;
  settingsService: SettingsService;
  historyService: HistoryService;
  loggingService: LoggingService;
  sshInfo?: SSHInfo;
  sshService?: ISSHService;
}

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
  const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;

  const {
    messages,
    liveResponse,
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

  const { slashCommands, toggleEditMode } = useAppCommands({
    settingsService,
    addSystemMessage,
    applyRuntimeSetting,
    setInput,
    clearConversation,
    exit,
    messages,
    setModel,
  });

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

  const handleSubmit = async (value: string): Promise<void> => {
    if (!value.trim()) return;

    // If waiting for rejection reason, handle it
    if (waitingForRejectionReason) {
      setWaitingForRejectionReason(false);
      setInput('');
      await handleApprovalDecision('n', value);
      return;
    }

    // If waiting for approval, ignore text input (handled by useInput)
    if (waitingForApproval) return;

    if (liteMode && isShellMode) {
      await handleShellSubmit(value);
      return;
    }

    // Parse the input to determine what to do
    const parsed = parseInput(value);

    switch (parsed.type) {
      case 'slash-command': {
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
        historyService.addMessage(value);
        setInput('');
        await sendUserMessage(value);
        return;
    }

    // Fallback: unknown slash command, send as message
    setInput('');
    await sendUserMessage(value);
  };

  return (
    <ErrorBoundary loggingService={loggingService}>
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        <Banner settingsService={settingsService} isShellMode={isShellMode} />
        {/* Main content area grows to fill available vertical space */}
        <Box flexDirection="column" flexGrow={1}>
          <MessageList messages={messages} />

          {liveResponse && liveResponse.text && <LiveResponse text={liveResponse.text} />}
        </Box>

        {/* Fixed bottom area for input / status */}
        <BottomArea
          pendingApproval={pendingApproval}
          waitingForApproval={waitingForApproval}
          waitingForRejectionReason={waitingForRejectionReason}
          isProcessing={isProcessing}
          isShellMode={isShellMode}
          lastUsage={lastUsage}
          onSubmit={handleSubmit}
          slashCommands={slashCommands}
          hasConversationHistory={messages.filter((msg) => msg.sender !== 'system').length > 0}
          settingsService={settingsService}
          loggingService={loggingService}
          historyService={historyService}
          onApprove={handleApprove}
          onReject={handleReject}
          sshInfo={sshInfo}
        />
      </Box>
    </ErrorBoundary>
  );
};

export default App;
