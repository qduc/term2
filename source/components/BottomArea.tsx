import React, { FC, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import ApprovalPrompt from './ApprovalPrompt.js';
import InputBox from './InputBox.js';
import StatusBar from './StatusBar.js';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings-service.js';
import type { LoggingService } from '../services/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import type { SSHInfo } from '../hooks/use-shell-mode.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import type { PendingApproval } from '../contracts/conversation.js';
import type { UserTurn } from '../types/user-turn.js';
import type { UndoItem } from '../hooks/use-undo-selection.js';

export type BottomAreaProps = {
  pendingApproval: PendingApproval | null;
  waitingForApproval: boolean;
  waitingForRejectionReason: boolean;
  isProcessing: boolean;
  isShellMode?: boolean;
  lastUsage?: NormalizedUsage | null;
  onSubmit: (value: UserTurn) => Promise<void>;
  slashCommands: SlashCommand[];
  hasConversationHistory: boolean;
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  onApprove: () => void;
  onReject: () => void;
  sshInfo?: SSHInfo;
  undoMenuRef?: React.MutableRefObject<{ open: (items: UndoItem[]) => void } | null>;
  onUndoSelect?: (item: UndoItem) => void;
  onSettingChange?: (key: string, value: any) => void;
};

const BottomArea: FC<BottomAreaProps> = ({
  pendingApproval,
  waitingForApproval,
  waitingForRejectionReason,
  isProcessing,
  isShellMode = false,
  onSubmit,
  slashCommands,
  hasConversationHistory,
  settingsService,
  loggingService,
  historyService,
  onApprove,
  onReject,
  sshInfo,
  lastUsage,
  undoMenuRef,
  onUndoSelect,
  onSettingChange,
}) => {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    if (!isProcessing) {
      setDotCount(1);
      return;
    }

    const interval = setInterval(() => {
      setDotCount((prev) => (prev === 3 ? 1 : prev + 1));
    }, 800);

    return () => clearInterval(interval);
  }, [isProcessing]);

  const showApprovalPrompt = waitingForApproval && !isProcessing && !waitingForRejectionReason && pendingApproval;
  const showInput = (!isProcessing && !waitingForApproval) || waitingForRejectionReason;

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" marginTop={1}>
        {showApprovalPrompt ? (
          <ApprovalPrompt approval={pendingApproval} onApprove={onApprove} onReject={onReject} />
        ) : isProcessing ? (
          <Text color="#64748b">processing{'.'.repeat(dotCount)}</Text>
        ) : showInput ? (
          <InputBox
            onSubmit={onSubmit}
            slashCommands={slashCommands}
            hasConversationHistory={hasConversationHistory}
            waitingForRejectionReason={waitingForRejectionReason}
            isShellMode={isShellMode}
            settingsService={settingsService}
            loggingService={loggingService}
            historyService={historyService}
            undoMenuRef={undoMenuRef}
            onUndoSelect={onUndoSelect}
            onSettingChange={onSettingChange}
          />
        ) : null}
      </Box>

      <StatusBar settingsService={settingsService} isShellMode={isShellMode} sshInfo={sshInfo} lastUsage={lastUsage} />
    </Box>
  );
};

export default BottomArea;
